import { readFileSync } from "node:fs";

/** Innermost `selector { body }` blocks, so rules inside media queries count too; `media` names the enclosing `@media` blocks. */
export function rules(file: string) {
  const css = readFileSync(
    new URL(`../../${file}`, import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const found: { selector: string; body: string; media: string }[] = [];
  const open: string[] = [];
  let start = 0;
  let leaf = false;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      open.push(css.slice(start, i).split(";").pop()!.trim());
      start = i + 1;
      leaf = true;
    } else if (css[i] === "}") {
      const selector = open.pop() ?? "";
      if (leaf)
        found.push({
          selector,
          body: css.slice(start, i),
          media: open.filter((block) => block.startsWith("@media")).join(" "),
        });
      start = i + 1;
      leaf = false;
    }
  }
  return found;
}
