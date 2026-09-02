# CoverYou Design System

CoverYou is an Indian **IRDAI-registered direct insurance broker (Life and General)** — the
footer in the source file reads *"Direct Broker (Life and General) · Valid Till: 08/06/2028 ·
Principal Officer- Mr. Deepanker Mahajan · Copyright © 2025 CoverYou"*. The brand line is
**"Click Karo. Cover Karo."**

The product is a comparison-and-buy platform plus a servicing account: nine lines of business
(Motor, Health, Term, Travel, Cyber, Property, Personal Accident, Professional Indemnity,
Public Liability, Comprehensive Package, Investment Plans), a large set of free calculators
(insurance, investment, tax planning and "additional tools" like BMI and EMI), and audience
sections for **Doctors** and **Hospitals**. Two surfaces are drawn in the source: a **1440px
web** site and a **390px mobile web / app**, each with its own header and footer, plus a
Material-3-derived component layer for in-product UI.

## Source

- **Figma file:** `Design System - CoverYou.fig`, attached to this project and mounted read-only.
  28 pages: Thumbnail, Foundations, Typography, Colors, Buttons, Depth, Corner Radius Scale,
  Icons, Core Components, Header, Footer, Generic Card, Accordian, Accordian Indicator, Avatar,
  Breadcrumbs, Button Group, Utilities, App Bar, Checkboxes, Date Time Picker, Dialogs,
  Radio buttons, Snackbars, Switch, Text Fields, Logo.
- No codebase, repository or deck was provided. Everything here was extracted from the .fig —
  token values, component geometry, icon paths, logo vectors and product copy.
- The file itself reports **688 component families** (659 variant sets + 293 standalone symbols,
  including a ~264-glyph icon set and a ~230-country flag set) and **761 Figma Variables across
  4 collections** (Ungrouped, cy variables, cy theme, cy Typography).

## Index

| Path | What |
| --- | --- |
| `styles.css` | Global entry point — `@import`s only. Consumers link this. |
| `tokens/fig-tokens.css` | All 761 Figma Variables, all 29 theme/mode scopes. Generated. |
| `tokens/semantic.css` | Short semantic aliases over those raw tokens. |
| `tokens/typography.css` | The 5-role × 9-size type system + `.cy-*` role classes. |
| `tokens/fonts.css` | Poppins / Inter / Roboto webfont loading. |
| `tokens/radius.css`, `tokens/elevation.css` | Corner-radius scale, depth and blur. |
| `components/buttons/` | Button - Primary / Secondary / Tertiary / Info. |
| `components/core/` | Every other primitive plus the Material building blocks they compose. |
| `assets/icons/` | `Icon` — 96 glyphs from the file's icon set at the 24px master. |
| `assets/flags/` | `Flag` — 230 full-colour country flags. |
| `assets/logo/` | `CYGrey`, `CYWhite`, `CYGreySymbol`, `CYWhiteSymbol` — the real wordmark and symbol. |
| `ui_kits/chrome/` | `WebHeader`, `WebFooter`, `MwebHeader`, `MWebFooter` — extracted verbatim. |
| `components/m3/` | Material label-button building blocks. |
| `templates/web-page/`, `templates/mweb-screen/` | Editable page templates for consuming projects. |
| `ui_kits/web/` | Desktop recreation: home, quote flow, claims dashboard. |
| `ui_kits/mweb/` | Mobile recreation: home, quote flow, account. |
| `guidelines/*.card.html` | Foundation specimen cards (Colors, Type, Spacing). |
| `SKILL.md` | Agent-Skills wrapper so this folder works in Claude Code. |

## CONTENT FUNDAMENTALS

**Voice.** Plain, transactional Indian-English with light Hinglish in brand lines only. The
tagline itself is Hinglish — *"Click Karo. Cover Karo."* — but product copy never is.

**Casing.** Sentence case for headings, labels and buttons ("Get a quote", "Renew", "Contact us").
Footer column headings are the one exception and are set in **ALL CAPS** ("PRODUCTS", "QUICK LINKS",
"INSURANCE CALCULATORS", "TAX PLANNING TOOLS"). Product names are Title Case because they are
proper product names: "Motor Insurance", "Term Insurance", "Professional Indemnity".

**Person.** Second person for the user ("your policy", "your claims"), first-person plural for
the company ("we place the policy"). Never "I".

**Nouns over verbs in navigation.** The web header is five nouns: Insurance, Renew, Claim,
Support, Resources. Buttons are verb phrases: "Login", "Get a quote", "Renew now", "Buy Now".

**Numbers.** Rupee amounts as `₹ 7,318` with a space after the symbol and Indian digit grouping.
Dates as `08/06/2028`. Regulatory strings are quoted verbatim, never paraphrased.

**No emoji** in product UI. (The internal typography-documentation frame uses 📊 in its own
title; that is documentation chrome, not brand voice.)

**Vibe.** Reassuring and administrative rather than playful — an insurance broker that wants to
look like it will actually pick up the phone. Copy answers a question per line; the FAQ
accordions are written as real user questions ("What does own-damage cover include?").

## VISUAL FOUNDATIONS

**Colour.** Two fixed brand colours: **CY Orange `rgb(240,93,73)`** and **CY Grey `rgb(17,17,17)`**.
Orange is the accent — CTAs, active states, the `U` of the logo, the small full-stops in the
tagline — never a large flat field except in brand/marketing headers. `brand-primary` is the
orange ramp (50 `rgb(253,234,231)` → 900 `rgb(48,19,15)`); `brand` is a separate blue ramp
(600 `rgb(13,62,149)`); `brand-secondary` is a warm-neutral ramp. Neutrals run 0 → 1000 with two
parallel families (a pure grey `neutral-*` and a cooler blue-grey `neutral-*-2` set at
`rgb(30,32,40)` / `rgb(40,42,54)` / `rgb(107,111,140)`). Status colours come in four-part
containers — `bg` / `label` / `accent` / `data` — for info, success, warning and critical.
Interactive colour is fully state-tokenised: every interactive family has
`enabled / hovered / focused / pressed / ring / label / accent`.

**Themes.** `cy theme` ships light and dark (`:root[data-theme="dark"]`), and `tokens/fig-tokens.css`
also carries 27 further Material palette modes (`data-mode="orange-lt"`, `"indigo-dt"`,
`"wireframe"`, …) inherited from the M3 base the component layer was built on.

**Type.** **Poppins** is the brand face (`font/family/title`). Inter and Roboto appear only inside
the Material building blocks. The system is 5 roles × 9 sizes: Body (Regular, main content),
Label (Medium, form labels/tags/badges), Title (SemiBold, section and card titles),
Sub Heading (SemiBold, page headings), Heading (Bold, hero). Desktop ladder 14/16/18/20/22/24/28/36/56;
mobile ladder 12/14/16/18 plus a 24px weight study across Regular → ExtraBold. Line-heights are
tight — display text sits at 100–115%.

**Spacing.** Layout gaps are large and even: 12 / 16 / 20 / 24 / 32 / 48 / 60 / 120 px, with
150px page padding on documentation frames. Buttons carry role-specific padding rather than a
grid: Huge is 64px tall with `20px 24px` padding and a 12px gap; Large 56px / `16px 24px`;
Medium 48px / `12px 16px`; Small 32px / `8px 12px`. Icon slot is 24px.

**Corner radii.** A named 10-step scale: 0, 4 (Extra-small), 8 (Small), 12 (Medium), 16 (Large),
20 (Large-increased), 28 (Extra-large), 32 (Extra-large-increased), 48 (Extra-extra-large), Full
(50%). Buttons are 12 (8 at `sm`); cards 16; sheets and documentation frames 32.

**Cards and depth.** Cards are white on a light surface, radius 16, with a **1px inset hairline
`rgba(0,0,0,0.1)`** and a soft, very low-opacity drop shadow. Only two shadow steps exist:
`0px 4px 4px rgba(0,0,0,0.03)` and `0px 25px 30px rgba(0,0,0,0.08)`. No coloured or glowing
shadows anywhere. Every elevated surface keeps the hairline; on dark surfaces it flips to
`rgba(255,255,255,0.1)`.

**Transparency and blur.** Used in exactly one place: media. A `rgba(0,0,0,0.6)` scrim with
`backdrop-filter: blur(30px)` (light) or `blur(60px)` (heavy) sits over imagery so text can
survive on top — the file calls these "Blur BG Light 30" and "Blur BG Heavy 60". Protection is a
capsule/panel, not a gradient. The web header itself sits on `rgba(255,255,255,0.25)`.

**States.** Hover darkens by one ramp step (primary neutral `#1E2028` → `#282A36`; secondary
`#E1E3EE` → hovered, pressed `#CCD0DE`). Pressed darkens one further step. Focus is a ring —
the specs literally read "Border weight : 8" — not an outline colour change. Disabled is
**opacity 50%**, uniformly, on every family. Nothing scales or bounces on press.

**Motion.** The file specifies no motion. Treat transitions as short and unshowy: 120–200ms on
colour and shadow with a standard ease (`--ease-standard`). No bounce, no spring, no parallax.

**Imagery.** Photography is warm, natural and un-graded — real people, no duotone, no grain
overlay. Avatars are circular photos with an optional 2–6px border and an optional story ring;
add-on overlays (badges, status dots, small icons) hang off the avatar's edge. Media placeholders
are 16:9 or 1:1 with radius 16.

**Layout.** Web is a fixed 1440 canvas with 32px gutters and an 88px header; mobile web is 390
wide with a status bar, app bar and a bottom navigation bar. Footers are dense multi-column link
directories — six to eight columns of calculators and products — which is a deliberate SEO/
navigation choice, not clutter.

## ICONOGRAPHY

The file carries its **own icon set**, not a third-party library. Two families:

- `$icon-line-*` — 1.5px-ish single-stroke outline glyphs, the default in UI.
- `$icon-filled-*` / `$icon-fill-*` — solid glyphs, used for emphasis, media controls, avatar
  add-ons and third-party brand marks (Visa, Mastercard, Amex, PayPal, Apple, Android, Google,
  WhatsApp, Instagram, LinkedIn, X, YouTube, TikTok, Telegram, Slack, Uber, Netflix, Airbnb,
  Amazon, plus ~40 crypto tokens and circled currency symbols including the ₹ rupee).

Every glyph is a component set with **nine sizes** — 12, 16, 20, 24, 32, 48, 64, 128, 256px —
and 20px is by far the most-used (3,095 instances). Icons are single-colour and inherit
`currentColor`. There is **no icon font**; glyphs are vectors. A separate
**`Full Color/Flag/*`** family holds ~230 full-colour country flags at 24px, used for phone
country codes and travel cover.

Emoji are not used as icons. Unicode is used only for the currency symbol (₹) and the copyright
mark (©).

Both sets are shipped here as data + a wrapper: `assets/icons/` (`<Icon name="IconLineHeart" size={20} />`,
96 glyphs) and `assets/flags/` (`<Flag name="FullColorFlagIndia" size={24} />`, 230 flags).
Names are the source component names, PascalCased.

## Components

All components are React, styled inline against the CSS custom properties, and exported on
`window.DesignSystem_09b347`. Names are the source Figma names, PascalCased — including a few
awkward ones (`BadgesSmallBrandSolidFalse` is the Badge symbol's full variant name;
`HorizontalFullWidth` is the Generic Card's "Horizontal / Full-width" set).

**Buttons** (`components/buttons/`): ButtonPrimary, ButtonSecondary, ButtonTertiary, ButtonInfo, IconLineSparkleStar.

**Core** (`components/core/`): Accordion, AppBar, ArrowDropDown, Avatar, AvatarAddOnOverlay,
AvatarAddOns, BadgesSmallBrandSolidFalse, BasicDialog, Breadcrumbs, BuilderBreadcrumbOverflow,
BuildingBlocksAppBarContent, BuildingBlocksAppBarContent9, BuildingBlocksClockFace12,
BuildingBlocksClockFace24, BuildingBlocksDirectInputKeyboard, BuildingBlocksFlatSearchBar,
BuildingBlocksHour, BuildingBlocksHourLine, BuildingBlocksIconButtonLarge,
BuildingBlocksIconButtonLarge2, BuildingBlocksIconButtonMedium, BuildingBlocksIconButtonMedium2,
BuildingBlocksIconButtonSmall, BuildingBlocksIconButtonSmall2, BuildingBlocksIconButtonXLarge,
BuildingBlocksIconButtonXLarge2, BuildingBlocksIconButtonXSmall, BuildingBlocksIconButtonXSmall2,
BuildingBlocksImageThumbnail, BuildingBlocksInput, BuildingBlocksLargeOutline,
BuildingBlocksLargeTonal, BuildingBlocksLocalM3Calendar, BuildingBlocksMediumOutline,
BuildingBlocksMediumTonal, BuildingBlocksMenuButton, BuildingBlocksMonogram,
BuildingBlocksNavigation, BuildingBlocksOnScrollSearch, BuildingBlocksPeriodSelector,
BuildingBlocksPeriodSelectorHorizontal, BuildingBlocksSmallOutline, BuildingBlocksSmallTonal,
BuildingBlocksSnackbarAction, BuildingBlocksSnackbarCloseAffordance, BuildingBlocksStateLayer1,
BuildingBlocksStateLayer2, BuildingBlocksStatusBar, BuildingBlocksVideoThumbnail,
BuildingBlocksXLargeOutline, BuildingBlocksXLargeTonal, BuildingBlocksXSmallOutline,
BuildingBlocksXSmallTonal, BuildingBlocksYear, ButtonGroup, ButtonGroupItem, CTAs, Check,
CheckIndeterminateSmall, CheckSmall, Checkboxes, Close, DeviceFrame, DropdownItemSuffix,
DropdownListItem, GIF, GTranslate, HorizontalFullWidth, IconButton, IconFillDm, IconFillPhone,
IconFilledCommentRound, IconFilledFilledEdit, IconFilledFilledThumbsDown,
IconFilledFilledThumbsUp, IconFilledHeart, IconFilledLiveBroadcast, IconFilledMail,
IconFilledMusic, IconFilledShareBack, IconFilledVideo, IconLineActionsMinus, IconLineActionsPlus,
IconLineArrowChevronForward, IconLineCheck, IconsKeyboardReturn24px, InputCheckboxIndicator,
Keyboard, KeyboardReturn, Language, LineDarkmodeActionsMinus, LineLightmodeCheck, Menu, Mic,
MobileFriendly, ModalDatePicker, MoreHoriz, NavigateNext, People, RadioButtonChecked,
RadioButtonUnchecked, RadioButtons, SearchBar, Settings, SharedBuildingBlocksSlotComponent,
Snackbar, Stars, Sticker, Switch, TextField.

**Brand & assets**: Icon (`assets/icons/`), Flag (`assets/flags/`), CYGrey, CYGreySymbol,
CYWhite, CYWhiteSymbol (`assets/logo/`).

**Material label buttons** (`components/m3/`): BuildingBlocksLabelButtonsXSmall,
BuildingBlocksLabelButtonsSmall, BuildingBlocksLabelButtonsMedium, BuildingBlocksLabelButtonsLarge,
BuildingBlocksLabelButtonsXLarge — each folds the five styles (elevated / filled / outline / text /
tonal) and five states into props.

**Site chrome** (`ui_kits/chrome/`): WebHeader, WebFooter, MwebHeader, MWebFooter.

### Intentional additions

- **`Icon`** and **`Flag`** wrappers — the source has no icon component API, only one component
  set per glyph. A single data-driven wrapper is the only practical way to ship ~330 glyphs.

## Coverage and caveats

- **130 of 688 component families built.** The 563 unbuilt families are, in order of count:
  per-glyph icon size-variant sets (~264 glyph families × 9 sizes, shipped instead as the `Icon`
  data set), the ~230 individual `Full Color/Flag/*` symbols (shipped as the `Flag` data set),
  and per-size/per-state Material "Building Blocks" leaf sets whose parents *are* built
  (`.Building Blocks/Label Buttons/<size>/<style>` × 5 states, `.Building Blocks/Icon button/…`,
  `_Avatar Add-Ons` type/border-width matrices, `hour-line` angle variants). Documentation
  furniture (`_DS Template Header`, `_DS Template Title`, `_placeholder component`) is skipped
  deliberately. Every *user-facing* family in the file has a component.
- **0 text styles / 0 effect styles.** The file defines its type system as documentation frames
  and Figma Variables, not as Figma text styles, so `fig-typography.css` came back empty and was
  dropped; `tokens/typography.css` is hand-transcribed from those frames instead.
- **Fonts are loaded from Google Fonts.** A .fig carries no font binaries. Poppins, Inter and
  Roboto are the exact families the file names — not substitutes — but if you have licensed
  self-hosted copies, swap the `@import` in `tokens/fonts.css` for `@font-face` rules.
- Three tokens reference families with no available file: `Flow Circular` (`--static-font-brand`,
  `--static-font-plain`) and the weight-name strings `Regular` / `Medium`. Left pointing at their
  source values.
- **Icon glyph coverage is 96 of ~264.** The .fig virtual filesystem collapses repeated icon
  frames, so the remaining glyph names could not be enumerated to extract them. Ask for the
  remaining names (or an icon-sheet export) and they can be added to `assets/icons/icon-data.js`
  the same way.
- `assets/flags/flag-data.js` is 3 MB. Import it only on screens that need flags.
- Two flags (Costa Rica, Kiribati) lost a mask during extraction and render slightly flat.
- UI-kit screens compose real extracted components; the *screen layouts* are new, because the
  .fig contains no full product screens beyond header and footer. Copy and product taxonomy are
  taken from the real footer.
