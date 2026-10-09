import { mkdir, readFile, writeFile } from "node:fs/promises";
const output = new URL("../public/email-editor/", import.meta.url);
await mkdir(output, { recursive: true });
for (const [source, destination] of [
  ["dist/quill.js", "quill-2.0.3.js"],
  ["dist/quill.snow.css", "quill-2.0.3.css"],
  ["LICENSE", "LICENSE"],
]) {
  const content = await readFile(
    new URL("../node_modules/quill/" + source, import.meta.url),
    "utf8",
  );
  await writeFile(
    new URL(destination, output),
    content.replace(/\/\/# sourceMappingURL=.*$/gm, ""),
  );
}
