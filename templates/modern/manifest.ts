export const manifest = {
  id: "modern",
  name: "Modern",
  designLanguage: "Bold Montserrat display, electric-blue accent, soft-shadow cards on off-white.",
  // section type -> component filename (in templates/modern/components/)
  implements: {
    hero: "Hero.astro",
    faq: "Faq.astro",
    "cta-band": "Cta.astro",
  } as Record<string, string>,
};
