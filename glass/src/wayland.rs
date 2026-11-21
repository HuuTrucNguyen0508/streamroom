//! The overlay on Wayland compositors with wlr-layer-shell (Hyprland, Sway, KDE): a full-screen surface
//! on the Overlay layer of the shared monitor that takes no clicks and no keyboard focus.

use std::net::TcpListener;
use std::time::{Duration, Instant};

use smithay_client_toolkit::compositor::{CompositorHandler, CompositorState, FrameCallbackData, Region};
use smithay_client_toolkit::output::{OutputHandler, OutputState};
use smithay_client_toolkit::reexports::calloop::channel::{self, Event as ChannelEvent};
use smithay_client_toolkit::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay_client_toolkit::reexports::calloop::{EventLoop, LoopHandle, RegistrationToken};
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::registry::{ProvidesRegistryState, RegistryState};
use smithay_client_toolkit::shell::WaylandSurface;
use smithay_client_toolkit::shell::wlr_layer::{
    Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface, LayerSurfaceConfigure,
};
use smithay_client_toolkit::shm::slot::SlotPool;
use smithay_client_toolkit::shm::{Shm, ShmHandler};
use smithay_client_toolkit::{delegate_registry, registry_handlers};
use tiny_skia::Pixmap;
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::{wl_output, wl_shm, wl_surface};
use wayland_client::{Connection, QueueHandle};

use crate::app::{App, Target};
use crate::monitor::Output;
use crate::protocol::Inbound;
use crate::render::{self, Renderer};
use crate::server::{self, Event, Outbox};

pub fn run(listener: TcpListener, origins: Vec<String>, wanted: Option<String>) -> Result<(), String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("Can't reach the Wayland compositor: {e}"))?;
    let (globals, queue) = registry_queue_init(&conn).map_err(|e| e.to_string())?;
    let qh = queue.handle();
    let mut event_loop: EventLoop<Glass> = EventLoop::try_new().map_err(|e| e.to_string())?;
    WaylandSource::new(conn.clone(), queue).insert(event_loop.handle()).map_err(|e| e.to_string())?;

    let compositor = CompositorState::bind(&globals, &qh).map_err(|_| "The compositor has no wl_compositor.")?;
    let layer_shell = LayerShell::bind(&globals, &qh)
        .map_err(|_| "This compositor doesn't support wlr-layer-shell (Hyprland, Sway and KDE do; GNOME doesn't).")?;
    let shm = Shm::bind(&globals, &qh).map_err(|_| "The compositor has no wl_shm.")?;

    let (tx, rx) = channel::channel();
    let outbox = server::start(server::Config { origins }, listener, move |e| {
        let _ = tx.send(e);
    });
    event_loop
        .handle()
        .insert_source(rx, |event, _, glass: &mut Glass| {
            if let ChannelEvent::Msg(event) = event {
                // Marks only change the picture; everything else may change where it goes.
                let marks_only = matches!(&event, Event::Message(_, Inbound::Mark { .. } | Inbound::Forget { .. }));
                let now = glass.now();
                if glass.app.handle(event, now) {
                    glass.dirty = true;
                }
                let qh = glass.qh.clone();
                if marks_only { glass.draw(&qh) } else { glass.sync(&qh) }
            }
        })
        .map_err(|e| e.to_string())?;

    let mut glass = Glass {
        registry: RegistryState::new(&globals),
        outputs: OutputState::new(&globals, &qh),
        compositor,
        layer_shell,
        shm,
        pool: None,
        qh: qh.clone(),
        handle: event_loop.handle(),
        timer: None,
        app: App::new(wanted),
        outbox,
        renderer: Renderer::new(render::system_font()),
        overlay: None,
        dirty: false,
        started: Instant::now(),
        monitors: String::new(),
    };
    event_loop.run(None, &mut glass, |_| {}).map_err(|e| e.to_string())
}

struct Overlay {
    layer: LayerSurface,
    output: String,
    wl_output: wl_output::WlOutput,
    /// Logical size and integer scale, from the compositor.
    size: Option<(u32, u32)>,
    scale: u32,
    frame_pending: bool,
    pixmap: Option<Pixmap>,
}

struct Glass {
    registry: RegistryState,
    outputs: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    shm: Shm,
    pool: Option<SlotPool>,
    qh: QueueHandle<Glass>,
    handle: LoopHandle<'static, Glass>,
    /// Wakes the overlay when a pointer idles out or a stroke starts fading.
    timer: Option<RegistrationToken>,
    app: App,
    outbox: Outbox,
    renderer: Renderer,
    overlay: Option<Overlay>,
    dirty: bool,
    started: Instant,
    /// The monitor list last printed.
    monitors: String,
}

impl Glass {
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn output_list(&self) -> Vec<(Output, wl_output::WlOutput, u32)> {
        self.outputs
            .outputs()
            .filter_map(|o| {
                let info = self.outputs.info(&o)?;
                let (width, height) = info.logical_size?;
                Some((Output { name: info.name.clone()?, width, height }, o, info.scale_factor.max(1) as u32))
            })
            .collect()
    }

    /// Makes the overlay match what the app wants, then sends any status that is due.
    fn sync(&mut self, qh: &QueueHandle<Self>) {
        let list = self.output_list();
        let outputs: Vec<Output> = list.iter().map(|(o, ..)| o.clone()).collect();
        let names: Vec<String> = outputs.iter().map(|o| format!("{} {}×{}", o.name, o.width, o.height)).collect();
        let names = names.join(", ");
        if names != self.monitors {
            eprintln!("Monitors: {names}");
            self.monitors = names;
        }
        let want = match self.app.target(&outputs) {
            Target::On(o) => Some(o.name.clone()),
            Target::Nowhere | Target::Unplaced(_) => None,
        };
        if self.overlay.as_ref().map(|o| &o.output) != want.as_ref() {
            self.overlay = None;
            if let Some((o, wl_output, scale)) = list.into_iter().find(|(o, ..)| Some(&o.name) == want.as_ref()) {
                self.overlay = Some(self.create_overlay(qh, o.name, wl_output, scale));
                eprintln!("Drawing on {}", want.as_deref().unwrap_or_default());
            }
        }
        let mapped = self.overlay.as_ref().filter(|o| o.size.is_some()).map(|o| o.output.clone());
        if let Some((conn, text)) = self.app.status(&outputs, mapped.as_deref()) {
            if text.contains("\"why\":\"ambiguous\"") {
                eprintln!("More than one monitor matches the share. Start again with --output and the one you share.");
            } else if text.contains("\"why\":\"no-match\"") {
                eprintln!(
                    "The share matches none of the monitors, so nothing is drawn. Share a whole monitor, and check the name given to --output."
                );
            }
            self.outbox.send(conn, text);
        }
        self.draw(qh);
    }

    fn create_overlay(
        &self,
        qh: &QueueHandle<Self>,
        name: String,
        wl_output: wl_output::WlOutput,
        scale: u32,
    ) -> Overlay {
        let surface = self.compositor.create_surface(qh);
        let layer = self.layer_shell.create_layer_surface(
            qh,
            surface,
            Layer::Overlay,
            Some("streamroom-glass"),
            Some(&wl_output),
        );
        layer.set_anchor(Anchor::TOP | Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT);
        layer.set_exclusive_zone(-1);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        // An empty region, not none: none means "the whole surface takes input".
        if let Ok(region) = Region::new(&self.compositor) {
            layer.set_input_region(Some(region.wl_region()));
        }
        layer.commit();
        Overlay { layer, output: name, wl_output, size: None, scale, frame_pending: false, pixmap: None }
    }

    /// Paints a frame when something changed, and every compositor frame while a stroke fades. In between,
    /// a timer wakes it for the next pointer to idle out or stroke to start fading.
    fn draw(&mut self, qh: &QueueHandle<Self>) {
        let now = self.now();
        // Something just faded or idled out: the frame without it still has to be painted.
        if self.app.board.prune(now) {
            self.dirty = true;
        }
        let due = self.app.board.next_change(now);
        let fading = due.is_some_and(|t| t <= now);
        // A pending frame callback calls back here.
        let Some((w, h)) = self.overlay.as_ref().filter(|o| !o.frame_pending).and_then(|o| o.size) else { return };
        if !self.dirty && !fading {
            return self.wake_at(due, now);
        }
        self.dirty = false;
        let Some(overlay) = self.overlay.as_mut() else { return };
        let (pw, ph) = (w * overlay.scale, h * overlay.scale);
        if overlay.pixmap.as_ref().is_none_or(|p| (p.width(), p.height()) != (pw, ph)) {
            overlay.pixmap = Pixmap::new(pw, ph);
        }
        let Some(pixmap) = overlay.pixmap.as_mut() else { return };
        let me = self.app.share.as_ref().map(|s| s.me.as_str());
        self.renderer.paint(pixmap, &self.app.board.visible(now, me), overlay.scale as f32);

        let stride = pw as i32 * 4;
        let pool = match &mut self.pool {
            Some(pool) => pool,
            None => match SlotPool::new((stride * ph as i32) as usize, &self.shm) {
                Ok(pool) => self.pool.insert(pool),
                Err(e) => return eprintln!("No shared memory for the overlay: {e}"),
            },
        };
        let Ok((buffer, canvas)) = pool.create_buffer(pw as i32, ph as i32, stride, wl_shm::Format::Argb8888) else {
            return;
        };
        // tiny-skia is premultiplied RGBA; Argb8888 is premultiplied BGRA in memory.
        for (dst, src) in canvas.as_chunks_mut::<4>().0.iter_mut().zip(pixmap.data().as_chunks::<4>().0) {
            *dst = [src[2], src[1], src[0], src[3]];
        }
        let surface = overlay.layer.wl_surface();
        let _ = overlay.layer.set_buffer_scale(overlay.scale);
        if buffer.attach_to(surface).is_ok() {
            surface.damage_buffer(0, 0, pw as i32, ph as i32);
            surface.frame(qh, FrameCallbackData(surface.clone()));
            overlay.layer.commit();
            overlay.frame_pending = true;
        }
    }

    fn wake_at(&mut self, due: Option<f64>, now: f64) {
        if let Some(token) = self.timer.take() {
            self.handle.remove(token);
        }
        let Some(due) = due.filter(|&t| t > now) else { return };
        let timer = Timer::from_duration(Duration::from_secs_f64((due - now) / 1000.0));
        self.timer = self
            .handle
            .insert_source(timer, |_, _, glass| {
                glass.timer = None;
                glass.dirty = true;
                let qh = glass.qh.clone();
                glass.draw(&qh);
                TimeoutAction::Drop
            })
            .ok();
    }
}

impl CompositorHandler for Glass {
    /// The compositor's preferred integer scale for the overlay (fractional scaling isn't handled).
    fn scale_factor_changed(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: &wl_surface::WlSurface, factor: i32) {
        if let Some(o) = self.overlay.as_mut() {
            o.scale = factor.max(1) as u32;
            self.dirty = true;
        }
        self.draw(qh);
    }

    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
    }

    fn frame(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {
        if let Some(o) = self.overlay.as_mut() {
            o.frame_pending = false;
        }
        self.draw(qh);
    }

    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}

impl LayerShellHandler for Glass {
    fn closed(&mut self, _: &Connection, qh: &QueueHandle<Self>, layer: &LayerSurface) {
        if self.overlay.as_ref().is_some_and(|o| &o.layer == layer) {
            self.overlay = None;
        }
        self.sync(qh);
    }

    fn configure(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _: u32,
    ) {
        let Some(overlay) = self.overlay.as_mut().filter(|o| &o.layer == layer) else { return };
        let (w, h) = configure.new_size;
        if w == 0 || h == 0 {
            return;
        }
        overlay.size = Some((w, h));
        overlay.frame_pending = false;
        self.dirty = true;
        self.sync(qh);
    }
}

impl OutputHandler for Glass {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }

    fn new_output(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.sync(qh);
    }

    fn update_output(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: wl_output::WlOutput) {
        self.sync(qh);
    }

    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, output: wl_output::WlOutput) {
        if self.overlay.as_ref().is_some_and(|o| o.wl_output == output) {
            self.overlay = None;
        }
        // The output is still listed until this handler returns.
        self.handle.insert_idle(|glass| {
            let qh = glass.qh.clone();
            glass.sync(&qh);
        });
    }
}

impl ShmHandler for Glass {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

delegate_registry!(Glass);

impl ProvidesRegistryState for Glass {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    registry_handlers![OutputState];
}

smithay_client_toolkit::delegate_dispatch2!(Glass);
