// Template registry — exported by every template so the renderer can load
// any template by importing its registry. Templates never import from each other.
export { default as Base } from "./layouts/Base.astro";

import Hero from "./components/Hero.astro";
import Faq from "./components/Faq.astro";
import Cta from "./components/Cta.astro";
import ProgramCards from "./components/ProgramCards.astro";
import CoachGrid from "./components/CoachGrid.astro";
import Schedule from "./components/Schedule.astro";
import LocationMap from "./components/LocationMap.astro";
import StatsBand from "./components/StatsBand.astro";
import Testimonials from "./components/Testimonials.astro";
import Pricing from "./components/Pricing.astro";
import FeatureGrid from "./components/FeatureGrid.astro";
import ContentBlock from "./components/ContentBlock.astro";
import MediaBlock from "./components/MediaBlock.astro";
import ContactForm from "./components/ContactForm.astro";
import LeadForm from "./components/LeadForm.astro";
import LogoStrip from "./components/LogoStrip.astro";

export const COMPONENTS: Record<string, unknown> = {
  hero: Hero,
  faq: Faq,
  "cta-band": Cta,
  "program-cards": ProgramCards,
  "coach-grid": CoachGrid,
  schedule: Schedule,
  "location-map": LocationMap,
  "stats-band": StatsBand,
  testimonials: Testimonials,
  pricing: Pricing,
  "feature-grid": FeatureGrid,
  "content-block": ContentBlock,
  "media-block": MediaBlock,
  "contact-form": ContactForm,
  "lead-form": LeadForm,
  "logo-strip": LogoStrip,
};
