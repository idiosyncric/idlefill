// Copy-to-clipboard for the header's hand-off pair.
//
// navigator.clipboard is undefined on a plain-HTTP origin that is NOT
// loopback — isSecureContext excludes http://<tailnet-ip>:8787, and the
// Tauri shell loads the arbiter over exactly that origin. The dev server
// on localhost IS a secure context, so the async API is present there.
// The textarea+execCommand fallback works on every origin and rides the
// click's user activation. Resolves true only when the value really
// reached the clipboard: a blind "copied" label over an empty clipboard is
// the worst failure mode for a paste into an agent config.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopy(text);
    }
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-2000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
