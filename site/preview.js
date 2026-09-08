const preview = document.querySelector(".product-frame");
window.addEventListener("message", (event) => {
  if (!preview || event.origin !== "https://wayclub-live-demo.web.app" || event.source !== preview.contentWindow) return;
  const data = event.data;
  if (data?.type !== "wayclub-preview-height" || !Number.isFinite(data.height) || data.height < 100 || data.height > 2000) return;
  preview.style.setProperty("height", `${data.height}px`, "important");
});
