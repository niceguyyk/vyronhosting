# Vyron UI conventions

- Build all new or changed interface work in the existing shadcn/ui Nova design system. Reuse installed shadcn components before creating custom controls, use semantic tokens, and keep desktop and mobile behavior consistent.
- Use GSAP for JavaScript-driven website animation. In React, use `@gsap/react` with a scoped ref and automatic cleanup. Prefer coordinated timelines, staggered reveals, and purposeful micro-interactions throughout the interface.
- Respect `prefers-reduced-motion`: essential content must remain immediately visible and usable, while decorative loops, parallax, and large spatial movement are disabled.
- Animate compositor-friendly `transform` and opacity properties, avoid layout-thrashing animation, and verify animations in a real browser at desktop and mobile sizes.

