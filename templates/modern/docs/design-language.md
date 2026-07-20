# modern — design language

*Authored half of the template documentation. The generated component
reference lives in `components.md`; the machine-readable manifest is
`template.json`.*

## Character

Confident, energetic, approachable. This is the "professional franchise gym"
look: enormous Montserrat 900 headings in title case, generous whitespace on
an off-white ground, soft-shadow white cards, and one saturated electric-blue
accent doing all the interactive work. Navy bands (`#000b27`) provide rhythm
and gravity between light sections.

## Rules a site build should respect

- **One accent.** The client's brand accent colors every CTA, icon, numeral,
  and label. Never introduce a second saturated color.
- **Headings capitalize; body doesn't shout.** Section headings are 44px/900
  with `text-transform: capitalize`. Body copy stays 16-18px/500.
- **Cards float.** White cards always carry the soft shadow
  (`0 18px 40px rgba(6,9,10,0.05)`) and 12px radius — never hard borders.
- **Buttons are pills of intent**: 24×32 padding, 10px radius, 18px/700,
  play-arrow prefix on primary conversions.
- **Rhythm**: light → light → navy → light. Use `feature-grid#dark`,
  `stats-band`, `cta-band`, or `lead-form` as the navy beats; never stack two
  navy sections.
- **Photography**: real gym photos, warm and human. Hero photos must tolerate
  a heavy left gradient.

## When to choose this template

Gyms whose brand is friendly and community-first (family gyms, functional
fitness, boutique group training). Prefer `blackout` for hard-edged
performance brands.
