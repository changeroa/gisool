import { render } from "preact";

function App() {
  return <main><h1>gisool</h1></main>;
}

const el = document.getElementById("app");
if (el) render(<App />, el);
