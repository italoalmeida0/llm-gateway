# Interface design system

The Gateway and Indirect Code share a compact, quiet interface. Content carries
the hierarchy; controls use a small amount of depth to make interaction clear.
The reference is a carefully finished desktop application, with larger touch
targets on mobile.

## Foundations

`web/style.tailwindcss.css` owns all colors, radii, elevation and control sizes.
Both themes use the same components. Never put literal colors in page code.

| Element | Standard |
| --- | --- |
| Small nested details | `rounded-md`, 4 px |
| Buttons and fields | `rounded-lg`, 6 px |
| Cards, menus and dialogs | `rounded-xl`, 8 px |
| Composer | `rounded-2xl`, 10 px |
| Default control | 34 px minimum height |
| Small control | 28 px minimum height |
| Touch buttons / fields | 40 / 44 px minimum height |
| Dialog inset | 16 px |
| Dashboard card inset | 20 px |
| Page title / section / body | 24 / 14 / 13 px |

Keep circles for status dots, switch thumbs, and avatars. Use the neutral `ink-*`
scale for hierarchy and `brand-*` for focus, selection details and chart highlights.
Use status colors only when they communicate a state. Input, cache and output
token metrics stay separate; every budget is explicitly an output token budget.

## Components

- Use `Btn` for actions. `primary` marks the main action, `outline` supports it,
  `ghost` handles quiet actions and `danger` handles destructive confirmation.
  The gradient and inset highlight are deliberately subtle. Avoid glows and
  scaling animations; pressing a button moves it down one pixel.
- Use `Input` and `Select` for fields. Fields are recessed relative to the
  surrounding surface. Password fields include a visibility control.
- Use `Card` and `CardHeader` for content groups. Hovering a card must not shift
  its position. Nested settings usually need a divider instead of another card.
- Use `Segmented` for short sets of mutually exclusive options. The selected
  option is raised slightly and exposes `aria-pressed`.
- Use `SwitchCard` for a boolean setting that benefits from a description. Its
  native checkbox supports keyboard and label activation. The smaller settings
  switch uses the same track and thumb styles.
- Use `Modal` for dialogs. Its header and action footer stay visible while the
  body scrolls. Keep copy brief and put explanatory details next to their field.
  Preserve focus trapping, Escape, and focus restoration. `fullOnMobile` is
  available for workflows that need the whole mobile viewport.
- Use `ui-popover` with the existing floating helpers for menus and tooltips.
  They remain portaled, positioned with left/top, and use the shared z-index scale.

## Product surfaces

The Gateway shows labeled navigation on wide screens and an icon rail on tablets.
Its header provides location context; the page title introduces the content.
Indirect Code uses a darker workspace sidebar and a bounded composer with a
separate toolbar. Keep its original large illustration and tightly aligned
INDIRECT wordmark together. The shared `IndirectBrand` component scales this
lockup for short viewports without replacing the product's identity.

Keep meaningful focus outlines, hover states, disabled states and touch targets.
Respect reduced motion, including explicit USAL timings. Never animate dialogs
or toasts with `data-usal`, or retain transforms on containers with fixed children.

## Review

Review both themes at desktop, tablet and mobile widths. Check long content,
dialog scrolling, visible action footers, keyboard focus, password visibility,
selection controls and portaled menus. Use isolated fixtures for visual reviews;
never capture real credentials. Run lint, typecheck and relevant tests, then
leave current web and native daemon builds available locally.
