export const DESIGN_PREVIEW_BRIDGE_SCRIPT = `
(() => {
  const toTarget = (el) => ({
    id: el.getAttribute("data-disp8ch-id") || "",
    kind: el.getAttribute("data-disp8ch-edit") || "container",
    label: el.getAttribute("data-disp8ch-label") || el.getAttribute("data-disp8ch-id") || el.tagName.toLowerCase(),
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 220)
  });
  const sendTargets = () => {
    const targets = Array.from(document.querySelectorAll("[data-disp8ch-id]")).map(toTarget).filter((target) => target.id);
    parent.postMessage({ type: "disp8ch-design-targets", targets }, "*");
  };
  document.addEventListener("mouseover", (event) => {
    const el = event.target && event.target.closest && event.target.closest("[data-disp8ch-id]");
    if (el) parent.postMessage({ type: "disp8ch-design-hover", target: toTarget(el) }, "*");
  }, true);
  document.addEventListener("click", (event) => {
    const el = event.target && event.target.closest && event.target.closest("[data-disp8ch-id]");
    if (!el) return;
    parent.postMessage({ type: "disp8ch-design-select", target: toTarget(el) }, "*");
  }, true);
  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "disp8ch-design-select") {
      document.querySelectorAll("[data-disp8ch-host-selected]").forEach((el) => el.removeAttribute("data-disp8ch-host-selected"));
      if (message.id) {
        const el = document.querySelector("[data-disp8ch-id='" + CSS.escape(message.id) + "']");
        if (el) el.setAttribute("data-disp8ch-host-selected", "true");
      }
    }
  });
  sendTargets();
})();
`;

export function injectDesignPreviewBridge(source: string): string {
  const script = `<script>${DESIGN_PREVIEW_BRIDGE_SCRIPT}</script>`;
  const style = `<style>[data-disp8ch-host-selected="true"]{outline:2px solid #d34a38!important;outline-offset:2px!important}</style>`;
  if (/<\/body>/i.test(source)) return source.replace(/<\/body>/i, `${style}${script}</body>`);
  return `${source}${style}${script}`;
}
