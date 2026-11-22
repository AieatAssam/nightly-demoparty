// Renders a prompts/*.md template. Single pass, so a `{{TOKEN}}` inside an untrusted value is never expanded,
// and `<` in untrusted values is escaped so a value can never close an <UNTRUSTED_*_DATA> block.
const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const INPUTS_RE = /<!--\s*INPUTS:\s*([A-Z0-9_,\s]+?)\s*-->/;

/** Tokens declared in the template's `<!-- INPUTS: ... -->` header. */
export function declaredInputs(templateText: string): string[] {
  const m = INPUTS_RE.exec(templateText);
  if (!m) throw new Error("template has no <!-- INPUTS: ... --> header");
  return m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
}

/** `_JSON` values sit in JSON, where `<` decodes back to `<`; everything else gets `&lt;`. */
export function escapeLt(key: string, value: string): string {
  return value.replace(/</g, key.endsWith("_JSON") ? "\\u003c" : "&lt;");
}

export function renderPrompt(
  templateText: string,
  vars: Record<string, string>,
  options: { escapeHtmlLtKeys?: string[] } = {},
): string {
  const declared = new Set(declaredInputs(templateText));
  const used = new Set([...templateText.matchAll(TOKEN_RE)].map((m) => m[1]!));
  const errors: string[] = [];
  for (const t of used) if (!declared.has(t)) errors.push(`{{${t}}} is used but not declared in INPUTS`);
  for (const t of declared) {
    if (!used.has(t)) errors.push(`${t} is declared in INPUTS but never used`);
    if (typeof vars[t] !== "string") errors.push(`missing value for ${t}`);
  }
  for (const k of Object.keys(vars)) if (!declared.has(k)) errors.push(`unknown variable ${k}`);
  if (errors.length) throw new Error(`renderPrompt: ${errors.join("; ")}`);
  const escaped = new Set(options.escapeHtmlLtKeys ?? []);
  // Function replacer: `$&` and friends in values stay literal.
  return templateText.replace(TOKEN_RE, (_, k: string) => (escaped.has(k) ? escapeLt(k, vars[k]!) : vars[k]!));
}
