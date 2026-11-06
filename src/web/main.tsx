import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./ui/App.tsx";

render(<App />, document.getElementById("app")!);
