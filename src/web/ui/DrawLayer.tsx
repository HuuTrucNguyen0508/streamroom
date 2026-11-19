import { useEffect, useRef } from "preact/hooks";
import type { MemberId } from "../../shared/protocol.ts";
import { colorFor, contentRect, type Draw } from "../rtc/draw.ts";

/** Pointer moves go out at most this often; pen points go out as they come. */
const MOVE_EVERY_MS = 33;
/** Pen points closer than this (fraction of the picture) to the last one are skipped. */
const MIN_STEP = 0.0015;

interface Props {
  draw: Draw;
  /** The member whose share is on stage (our own id for our own share). */
  share: MemberId;
  selfId: MemberId | null;
  video: { readonly current: HTMLVideoElement | null };
  names: ReadonlyMap<MemberId, string>;
  /** Our pointer and pen go out only while this is on; everyone else's marks always show. */
  active: boolean;
  onExit(): void;
}

export function DrawLayer({ draw, share, selfId, video, names, active, onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const namesRef = useRef(names);
  namesRef.current = names;
  const selfRef = useRef(selfId);
  selfRef.current = selfId;

  // Paint whenever the board changes, and keep painting while anything is still fading.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const marks = draw.board.visible(share, performance.now());
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const v = video.current;
      const rect = contentRect(w, h, v?.videoWidth ?? 0, v?.videoHeight ?? 0);
      const at = (x: number, y: number) => [rect.x + x * rect.w, rect.y + y * rect.h] as const;
      for (const m of marks) {
        const color = colorFor(m.author);
        for (const stroke of m.strokes) paintStroke(ctx, stroke.points, stroke.alpha, color, dpr, at);
        // Our own pointer is the real mouse cursor.
        if (m.pointer && m.author !== selfRef.current) {
          const [px, py] = at(m.pointer.x, m.pointer.y);
          paintPointer(ctx, px, py, color, namesRef.current.get(m.author) ?? "", dpr);
        }
      }
      if (marks.length > 0) frame = requestAnimationFrame(paint);
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const unsubscribe = draw.subscribe(wake);
    const resize = new ResizeObserver(wake);
    resize.observe(canvas);
    const v = video.current;
    v?.addEventListener("resize", wake);
    wake();
    return () => {
      unsubscribe();
      resize.disconnect();
      v?.removeEventListener("resize", wake);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [draw, share, video]);

  // Our pointer and pen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    let pen = false;
    let inside = false;
    let last: { x: number; y: number } | null = null;
    let lastMoveAt = 0;
    let pendingMove: ReturnType<typeof setTimeout> | null = null;

    /** The pointer as a fraction of the picture, or null over the letterbox bars. */
    const locate = (ev: PointerEvent, clampToPicture: boolean) => {
      const box = canvas.getBoundingClientRect();
      const v = video.current;
      const rect = contentRect(box.width, box.height, v?.videoWidth ?? 0, v?.videoHeight ?? 0);
      if (rect.w <= 0 || rect.h <= 0) return null;
      const x = (ev.clientX - box.left - rect.x) / rect.w;
      const y = (ev.clientY - box.top - rect.y) / rect.h;
      if (!clampToPicture && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    };
    const cancelMove = () => {
      if (pendingMove) clearTimeout(pendingMove);
      pendingMove = null;
    };
    const leave = () => {
      cancelMove();
      if (inside || pen) draw.send({ t: "leave", s: share });
      inside = false;
      pen = false;
      last = null;
    };

    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const p = locate(ev, false);
      if (!p) return;
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      cancelMove();
      pen = true;
      inside = true;
      last = p;
      draw.send({ t: "down", s: share, ...p });
    };
    const onMove = (ev: PointerEvent) => {
      if (pen) {
        const p = locate(ev, true);
        if (!p) return;
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP) return;
        last = p;
        draw.send({ t: "line", s: share, ...p });
        return;
      }
      const p = locate(ev, false);
      if (!p) {
        if (inside) leave();
        return;
      }
      inside = true;
      const send = () => {
        pendingMove = null;
        lastMoveAt = performance.now();
        draw.send({ t: "move", s: share, ...p });
      };
      cancelMove();
      const wait = MOVE_EVERY_MS - (performance.now() - lastMoveAt);
      if (wait <= 0) send();
      else pendingMove = setTimeout(send, wait);
    };
    const onUp = (ev: PointerEvent) => {
      if (!pen) return;
      pen = false;
      last = null;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      draw.send({ t: "up", s: share });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onExit();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", onKey);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", onKey);
      leave();
    };
  }, [draw, share, video, active, onExit]);

  return <canvas ref={canvasRef} class={active ? "draw-layer is-active" : "draw-layer"} data-testid="draw-layer" aria-hidden="true" />;
}

function paintStroke(
  ctx: CanvasRenderingContext2D,
  points: readonly number[],
  alpha: number,
  color: string,
  dpr: number,
  at: (x: number, y: number) => readonly [number, number],
): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const [x0, y0] = at(points[0]!, points[1]!);
  ctx.moveTo(x0, y0);
  // A lone point still shows as a dot.
  if (points.length === 2) ctx.lineTo(x0 + 0.01, y0);
  for (let i = 2; i + 1 < points.length; i += 2) {
    const [x, y] = at(points[i]!, points[i + 1]!);
    ctx.lineTo(x, y);
  }
  // A dark edge keeps light colors readable on bright screens.
  ctx.strokeStyle = "rgb(10 9 20 / 0.55)";
  ctx.lineWidth = 6 * dpr;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5 * dpr;
  ctx.stroke();
  ctx.restore();
}

function paintPointer(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, name: string, dpr: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.5, 13);
  ctx.lineTo(7.5, 19.5);
  ctx.lineTo(10.5, 18.2);
  ctx.lineTo(7.6, 11.8);
  ctx.lineTo(13, 11.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgb(10 9 20 / 0.85)";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.fill();
  ctx.stroke();
  if (name) {
    ctx.font = '600 12px "Bricolage Grotesque Variable", system-ui, sans-serif';
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(14, 16, tw + 14, 20, 10);
    ctx.fill();
    ctx.fillStyle = "#15132a";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 21, 26.5);
  }
  ctx.restore();
}
