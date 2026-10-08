import * as React from "react";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";
import { Card, CardHeader, CardTitle, CardAction, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { setTheme, apiToken, type StateSnapshot } from "@/lib/api";
import { THEME_KEYS, DEFAULT_THEME, isHexColor, applyTheme } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Settings → the operator-tuned color scheme (#68). One row per token: the
// label, a native color picker, a hex text input, and the live current
// value. A live preview row shows a state-sample dot + word in the chosen
// color so the operator sees the effect before saving. "reset to defaults"
// posts the :root defaults (the exact index.css values). Save is token-
// gated (the qsToken pattern) — the write rides the arbiter's api token,
// and the response carries the effective map after the arbiter sanitizes.
// Flat by default: tonal panel + hairline, zero shadow (DESIGN.md).
// ---------------------------------------------------------------------------

// The value shown for a token: the saved theme (if any) else the :root default.
function currentFor(key: string, saved?: Record<string, string>): string {
  return saved?.[key] ?? DEFAULT_THEME[key];
}

export function Settings({ st }: { st: StateSnapshot | null }) {
  const saved = st?.theme?.colors;
  // The editable draft: one entry per token. Seeded from the saved theme (or
  // the :root defaults when unset). The draft is what Save posts; the live
  // preview reads it, so the operator sees the change before it reaches the
  // arbiter.
  const seed = (s?: Record<string, string>) =>
    Object.fromEntries(THEME_KEYS.map(({ key }) => [key, currentFor(key, s)]));
  const [draft, setDraft] = React.useState<Record<string, string>>(() => seed(undefined));
  const [saving, setSaving] = React.useState(false);
  // Re-seed when the persisted theme arrives or changes (the draft is seeded
  // at mount, when st is still null — without this the saved theme would never
  // display). Guard: never clobber an in-progress edit (the operator typed
  // since the last seed). The poll's 5s tick is the only thing that changes
  // `saved`, so this fires exactly when truth moves.
  const lastSeedRef = React.useRef<string>("");
  const editedRef = React.useRef(false);
  const savedSerialized = saved ? JSON.stringify(saved) : "";
  React.useEffect(() => {
    if (savedSerialized === lastSeedRef.current) return; // nothing new
    if (editedRef.current) return; // protect the in-progress edit
    setDraft(seed(saved));
    lastSeedRef.current = savedSerialized;
  }, [savedSerialized, saved]);

  const requireToken = (): boolean => {
    if (apiToken()) return true;
    toast.error("needs the arbiter API token — paste it in the header first");
    return false;
  };

  const set = (key: string, value: string) => {
    editedRef.current = true;
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const dirty = THEME_KEYS.some(({ key }) => draft[key] !== currentFor(key, saved));

  const doSave = async (payload: Record<string, string>, label: string) => {
    if (!requireToken()) return;
    setSaving(true);
    try {
      const res = await setTheme(payload);
      applyTheme(res.colors); // the apply channel: reflect the effective map now
      setDraft(Object.fromEntries(THEME_KEYS.map(({ key }) => [key, res.colors[key] ?? DEFAULT_THEME[key]])));
      lastSeedRef.current = JSON.stringify(res.colors); // the fresh truth; no re-seed needed
      editedRef.current = false;
      toast.success(`${label}${res.applied > 0 ? ` · ${res.applied} token(s) set` : ""}`);
    } catch (e) {
      toast.error(`save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Settings</h2>
        <p className="text-[12px] text-dim">the dashboard color scheme — the nine :root tokens.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Color scheme</CardTitle>
          <CardAction className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => {
                doSave(Object.fromEntries(THEME_KEYS.map(({ key }) => [key, DEFAULT_THEME[key]])), "reset to defaults");
              }}
            >
              <RotateCcw className="size-3" /> reset to defaults
            </Button>
            <Button
              size="xs"
              disabled={saving || !dirty}
              onClick={() => doSave(draft, "saved")}
            >
              <Save className="size-3" /> {saving ? "saving…" : "save"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1.5">
            {THEME_KEYS.map(({ key, label }) => {
              const value = draft[key];
              const valid = isHexColor(value);
              return (
                <React.Fragment key={key}>
                  <div className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 rounded-sm border border-border bg-panel px-3 py-2">
                    <span className="text-[12px]">{label}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={isHexColor(value) ? value : DEFAULT_THEME[key]}
                        onChange={(e) => set(key, e.target.value)}
                        aria-label={`${label} color picker`}
                        className="h-6 w-8 cursor-pointer rounded-sm border border-border bg-transparent"
                      />
                      <Input
                        value={value}
                        onChange={(e) => set(key, e.target.value)}
                        aria-label={`${label} hex value`}
                        spellCheck={false}
                        className={`h-6 w-28 font-mono text-[12px] ${valid ? "" : "text-err"}`}
                      />
                      {!valid && <span className="text-[11px] text-err">not a #hex</span>}
                    </div>
                    {/* The live preview: a state-sample dot + word in the chosen color. */}
                    <span className="flex items-center gap-2 text-[12px]">
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ backgroundColor: valid ? value : "transparent" }}
                      />
                      <span style={{ color: valid ? value : undefined }}>running</span>
                    </span>
                  </div>
                  {key !== THEME_KEYS[THEME_KEYS.length - 1].key && <Separator className="my-1" />}
                </React.Fragment>
              );
            })}
          </div>
        </CardContent>
        <CardFooter>
          <p className="text-[11px] text-dim">
            a token left at its default keeps the :root value. an unset theme shows the defaults on every reload.
          </p>
        </CardFooter>
      </Card>
    </section>
  );
}
