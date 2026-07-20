/**
 * The modern template's component registry — one entry per section type in
 * the closed vocabulary, plus chrome (Base/Nav/Footer). A template IS this
 * registry + its design tokens + its docs.
 */
import Base from "./layouts/Base.astro";
import Nav from "./components/Nav.astro";
import Footer from "./components/Footer.astro";
import Hero from "./components/Hero.astro";
import ProgramCards from "./components/ProgramCards.astro";
import CoachGrid from "./components/CoachGrid.astro";
import Schedule from "./components/Schedule.astro";
import Testimonials from "./components/Testimonials.astro";
import Faq from "./components/Faq.astro";
import CtaBand from "./components/CtaBand.astro";
import LocationMap from "./components/LocationMap.astro";
import ContactForm from "./components/ContactForm.astro";
import LeadForm from "./components/LeadForm.astro";
import Pricing from "./components/Pricing.astro";
import FeatureGrid from "./components/FeatureGrid.astro";
import ContentBlock from "./components/ContentBlock.astro";
import MediaBlock from "./components/MediaBlock.astro";
import StatsBand from "./components/StatsBand.astro";
import LogoStrip from "./components/LogoStrip.astro";

export default {
  name: "modern",
  Base,
  Nav,
  Footer,
  components: {
    hero: Hero,
    "program-cards": ProgramCards,
    "coach-grid": CoachGrid,
    schedule: Schedule,
    testimonials: Testimonials,
    faq: Faq,
    "cta-band": CtaBand,
    "location-map": LocationMap,
    "contact-form": ContactForm,
    "lead-form": LeadForm,
    pricing: Pricing,
    "feature-grid": FeatureGrid,
    "content-block": ContentBlock,
    "media-block": MediaBlock,
    "stats-band": StatsBand,
    "logo-strip": LogoStrip,
  } as Record<string, unknown>,
};
