# ARC palette

The palette comes from the official [Speranza Security recruitment article](https://arcraiders.com/news/speranza-security-recruitment), inspected on October 23, 2026.

| Token                | Light           | Dark            |
| -------------------- | --------------- | --------------- |
| Background           | Cream `#ECE2D0` | Ink `#130918`   |
| Foreground           | Ink `#130918`   | Cream `#ECE2D0` |
| Primary              | Amber `#F1AA1C` | Amber `#F1AA1C` |
| Primary foreground   | Ink `#130918`   | Ink `#130918`   |
| Secondary            | Ink             | Cream           |
| Secondary foreground | Cream           | Ink             |

The source page uses Barlow, cream backgrounds, ink text, amber primary actions, and 5px button corners. Keep Fontsource Barlow for all typography. The source site's cookie-consent widget has a separate palette; its blue defaults are not ARC brand colors.

Dark mode reverses the neutral foreground and background roles. It retains amber as a recognizable brand accent rather than applying an RGB color inversion. Card, muted, border, chart, and sidebar tokens derive from these roles with `color-mix()`, so both modes share one palette. Error colors are local functional extensions, not colors sampled from the source site.

`src/styles.css` owns the tokens. Use semantic Tailwind classes in components, including `bg-card`, `text-muted-foreground`, and `border-border`. Avoid fixed purple backgrounds or foregrounds that bypass light mode. The existing dark default is preserved; removing `.dark` from the root selects the official light palette.
