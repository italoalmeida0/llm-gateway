interface FileIconSpec { icon: string; class: string }
const tones: Record<string, string> = {
  builtin: "text-[var(--code-builtin)]", type: "text-[var(--code-type)]",
  num: "text-[var(--code-num)]", meta: "text-[var(--code-meta)]",
  kw: "text-[var(--code-kw)]", str: "text-[var(--code-str)]", comment: "text-ink-400",
};
const groups: Array<{ extensions: string; icon: string; tone: string }> = [
  { extensions: "py pyi pyw ipynb", icon: "mdi:language-python", tone: "builtin" },
  { extensions: "tsx jsx", icon: "mdi:react", tone: "type" },
  { extensions: "ts mts cts", icon: "mdi:language-typescript", tone: "type" },
  { extensions: "js mjs cjs", icon: "mdi:language-javascript", tone: "num" },
  { extensions: "vue", icon: "mdi:vuejs", tone: "str" },
  { extensions: "svelte astro", icon: "lucide:component", tone: "meta" },
  { extensions: "go mod sum", icon: "mdi:language-go", tone: "type" },
  { extensions: "rs", icon: "mdi:language-rust", tone: "meta" },
  { extensions: "c h", icon: "mdi:language-c", tone: "type" },
  { extensions: "cpp cc cxx hpp hh hxx ino", icon: "mdi:language-cpp", tone: "type" },
  { extensions: "cs csx", icon: "mdi:language-csharp", tone: "kw" },
  { extensions: "java jar class", icon: "mdi:language-java", tone: "meta" },
  { extensions: "kt kts", icon: "mdi:language-kotlin", tone: "kw" },
  { extensions: "swift m mm", icon: "mdi:language-swift", tone: "meta" },
  { extensions: "rb erb gem gemspec", icon: "mdi:language-ruby", tone: "meta" },
  { extensions: "php phtml", icon: "mdi:language-php", tone: "kw" },
  { extensions: "lua", icon: "mdi:language-lua", tone: "type" },
  { extensions: "r rmd", icon: "mdi:language-r", tone: "type" },
  { extensions: "hs lhs", icon: "mdi:language-haskell", tone: "kw" },
  { extensions: "f f90 f95 for", icon: "mdi:language-fortran", tone: "kw" },
  { extensions: "dart ex exs erl hrl clj cljs cljc edn scala sc pl pm ml mli fs fsx vb zig nim sol groovy gradle asm s", icon: "lucide:file-code-2", tone: "kw" },
  { extensions: "html htm xhtml", icon: "mdi:language-html5", tone: "meta" },
  { extensions: "css scss sass less styl", icon: "mdi:language-css3", tone: "kw" },
  { extensions: "xml xsl xslt xsd plist manifest", icon: "lucide:code-xml", tone: "meta" },
  { extensions: "xaml", icon: "mdi:language-xaml", tone: "type" },
  { extensions: "json jsonc json5 ndjson jsonl yaml yml toml ini cfg conf properties", icon: "lucide:braces", tone: "num" },
  { extensions: "md mdx markdown", icon: "mdi:language-markdown", tone: "type" },
  { extensions: "txt rst adoc tex org log", icon: "lucide:file-text", tone: "comment" },
  { extensions: "sh bash zsh fish ps1 psm1 bat cmd", icon: "lucide:terminal", tone: "str" },
  { extensions: "sql sqlite sqlite3 db prisma", icon: "mdi:database", tone: "num" },
  { extensions: "graphql gql proto", icon: "lucide:network", tone: "kw" },
  { extensions: "tf tfvars", icon: "mdi:terraform", tone: "kw" },
  { extensions: "png jpg jpeg gif webp svg ico bmp tiff tif avif heic psd ai eps", icon: "lucide:image", tone: "kw" },
  { extensions: "pdf", icon: "mdi:file-pdf-box", tone: "meta" },
  { extensions: "doc docx odt rtf", icon: "mdi:file-word", tone: "type" },
  { extensions: "xls xlsx ods csv tsv parquet", icon: "mdi:file-excel", tone: "str" },
  { extensions: "ppt pptx odp", icon: "mdi:file-powerpoint", tone: "meta" },
  { extensions: "mp3 wav flac ogg aac m4a mid midi", icon: "mdi:file-music", tone: "kw" },
  { extensions: "mp4 mov mkv webm avi m4v", icon: "mdi:file-video", tone: "kw" },
  { extensions: "zip tar gz bz2 xz 7z rar tgz zst", icon: "lucide:file-archive", tone: "num" },
  { extensions: "woff woff2 ttf otf eot", icon: "lucide:type", tone: "meta" },
  { extensions: "pem crt cer p12 pfx key pub", icon: "mdi:file-key", tone: "num" },
  { extensions: "lock", icon: "lucide:lock-keyhole", tone: "comment" },
  { extensions: "exe dll so dylib bin wasm o a lib deb rpm apk dmg iso", icon: "mdi:package-variant-closed", tone: "comment" },
  { extensions: "diff patch", icon: "lucide:file-diff", tone: "str" },
];
const byExtension = new Map<string, FileIconSpec>();
for (const group of groups) for (const ext of group.extensions.split(" ")) {
  byExtension.set(ext, { icon: group.icon, class: tones[group.tone] });
}
const named = (icon: string, tone = "type"): FileIconSpec => ({ icon, class: tones[tone] });

export function fileIcon(path: string): FileIconSpec {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (/^(dockerfile|containerfile)(\.|$)/.test(name) || /^(docker-)?compose[.]/.test(name)) return named("mdi:docker");
  if (/^\.git|^\.gitattributes$/.test(name)) return named("mdi:git", "meta");
  if (/^\.env($|\.)/.test(name)) return named("mdi:file-key", "num");
  if (/^(package(-lock)?\.json|npm-shrinkwrap\.json|\.npmrc|\.yarnrc.*|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(name)) return named("mdi:npm", "meta");
  if (/^(makefile|gnumakefile|justfile|cmakelists\.txt|.*\.cmake)$/.test(name)) return named("lucide:hammer", "str");
  if (/^(license|licence|copying)(\.|$)/.test(name)) return named("lucide:scale", "num");
  if (/^(\.editorconfig|.*\.config\..*|tsconfig.*\.json|\.prettier.*|\.eslint.*)$/.test(name)) return named("mdi:file-cog", "comment");
  if (/\.(test|spec)\.[^.]+$/.test(name)) return named("mdi:test-tube", "str");
  return byExtension.get(name.split(".").pop() || "") || named("lucide:file-text", "comment");
}
