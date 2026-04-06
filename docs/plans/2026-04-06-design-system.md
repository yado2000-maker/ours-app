# Sheli Design System v2

**Date:** 2026-04-06
**Direction:** Modern Israeli startup × Playful family app
**Replaces:** v1 "AI beige" aesthetic (Claude/ChatGPT-inspired)

## Brand Mark

- **Wordmark:** lowercase "sheli" in Nunito 800, coral→pink gradient
- **Icon:** Coral→pink gradient rounded square (rx:44) + white "sheli" wordmark with subtle drop shadow
- **Icon file:** `/public/icons/icon.svg`
- **Casing:** Always lowercase "sheli" in the wordmark. Hebrew "שלי" keeps normal casing.

## Color Palette

### Light Theme
```
--cream:    #FAFCFB   (cool neutral white — NOT beige)
--dark:     #1E2D2D   (deep teal-gray text)
--warm:     #4A5858   (secondary text)
--muted:    #8A9494   (disabled/hint text)
--white:    #FFFFFF   (card backgrounds)
--border:   #E4EAEA   (cool gray dividers)

--primary:       #E8725C   (coral — brand, wordmark, badges, notifications)
--primary-soft:  rgba(232,114,92,0.10)
--primary-light: #FFF5F3

--accent:        #2AB673   (green — Sheli's voice, confirmations, WhatsApp)
--accent-soft:   rgba(42,182,115,0.10)
--accent-light:  #EEFBF3
--green:         #2AB673   (alias for --accent)

Gradient: linear-gradient(135deg, #E8725C, #D4507A)  — wordmark + icon
CTA:      #2D8E6F  (muted forest green — WhatsApp buttons)
```

### Dark Theme
```
--cream:    #121E1E
--dark:     #F0E8E4
--warm:     #C8B0AA
--primary:  #F0886E
--accent:   #3DC882
--green:    #3DC882
```

## Typography

| Use | Font | Weight | Notes |
|-----|------|--------|-------|
| Hebrew body | Heebo | 300-600 | Best Hebrew web font. letter-spacing: 0 |
| English body | Nunito | 400-700 | Rounder than DM Sans, friendlier |
| Wordmark | Nunito | 800 | Lowercase "sheli", gradient fill, letter-spacing: 0.04em |
| Section titles (HE) | Heebo | 700 | NOT Cormorant Garamond |
| Hebrew headings in auth | Heebo | 500 | letter-spacing: 0, not Cormorant |

**Banned:** Cormorant Garamond (removed — too "luxury editorial" for a family app), DM Sans (replaced by Nunito)

## Color Roles

| Role | Color | Used for |
|------|-------|----------|
| **Brand identity** | Coral `--primary` | Wordmark, step numbers, feature icons, badges, nav badges |
| **Sheli's voice** | Green `--accent` | Chat bubbles, nav active bar, confirmations, check circles |
| **WhatsApp CTA** | Forest green `#2D8E6F` | "Add Sheli to group" buttons (muted, not neon WhatsApp green) |
| **Dark text** | Teal-gray `--dark` | Headings, body, buttons |
| **Canvas** | Cool white `--cream` | Page backgrounds |

## Icon Sizes

| Size | Use |
|------|-----|
| SVG (any) | Favicon, modern browsers |
| 192×192 PNG | PWA icon, Apple touch icon |
| 512×512 PNG | PWA splash, app stores |

## Spacing & Radius

```
--radius-card: 16px
--radius-pill: 100px
--radius-btn:  14px
```

## What Changed from v1

| Before | After |
|--------|-------|
| Cream/beige backgrounds (`#FAF8F5`) | Cool neutral white (`#FAFCFB`) |
| Brown text/borders | Teal-gray text/borders |
| Terracotta accent (`#D4845A`) | Coral primary (`#E8725C`) + green accent (`#2AB673`) |
| Cormorant Garamond serif wordmark | Nunito 800 gradient wordmark |
| DM Sans body font | Nunito body font |
| "Sheli" (capital S) | "sheli" (lowercase, matching icon) |
| Flat color wordmark | Coral→pink gradient with drop shadow |
| Neon WhatsApp green CTA (`#25D366`) | Muted forest green CTA (`#2D8E6F`) |
| `theme-color: #1C1A17` | `theme-color: #E8725C` |
