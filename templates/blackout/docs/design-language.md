# blackout — design language

*Authored half of the template documentation. The generated component
reference lives in `components.md`; the machine-readable manifest is
`template.json`.*

## Character

Brutal, loud, performance-first. Pure black ground, Outfit 900 uppercase
headings with tight (-2%) tracking, hairline dividers, and a single vivid
blue that arrives in big geometric slabs: skewed parallelogram buttons,
diagonal-clipped bands, and the blue/black checkerboard tile grid. White
sections appear as hard breaks, never soft ones.

## Rules a site build should respect

- **Everything display-weight is uppercase.** Headings, buttons, nav, names.
  Body copy is 300-weight and never uppercase — the contrast is the design.
- **No radius, no shadows.** Corners are square; separation comes from color
  blocks and hairlines (`rgba(255,255,255,0.1)`).
- **The skew is sacred.** Primary buttons are parallelograms
  (`skewX(-10deg)`, label counter-skewed). Don't introduce rounded buttons.
- **Diagonals mark conversion.** `cta-band`, `lead-form`, and `stats-band`
  carry clipped diagonal edges — these are the pages' loudest moments; use
  at most two diagonal sections per page.
- **Checkerboard once.** `feature-grid#dark` is the signature; exactly one
  per page, 4-6 tiles.
- **Photography**: high-contrast, desaturated toward grayscale; portraits and
  program shots get the built-in filter.

## When to choose this template

Performance and strength brands: CrossFit boxes, powerlifting, combat sports
— gyms that want intensity. Prefer `modern` for warm community brands.
