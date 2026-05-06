import React from 'react';

// =============================================================================
// OURS FAMILY APP — SVG ICON LIBRARY
// =============================================================================
// Design system: stroke-based, 1.5-2px stroke, round caps/joins, currentColor
// Aesthetic: warm, minimal, handcrafted — like a premium notebook app
// =============================================================================

// -----------------------------------------------------------------------------
// NAVIGATION (Bottom Bar)
// -----------------------------------------------------------------------------

/** Speech bubble — rounded, warm feel with a small tail */
export function ChatIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4.5 14.5L3.2 16.8C3.05 17.06 3.3 17.38 3.58 17.27L7 16C7 16 8.4 16.5 10 16.5C14.14 16.5 17.5 13.36 17.5 9.5C17.5 5.64 14.14 2.5 10 2.5C5.86 2.5 2.5 5.64 2.5 9.5C2.5 11.5 3.3 13.28 4.5 14.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Checkbox with a checkmark — rounded corners, satisfying check */
export function TasksIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="3"
        y="3"
        width="14"
        height="14"
        rx="3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 10.2L8.8 12.5L13.5 7.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Shopping bag — minimal, with handles */
export function ShoppingIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4.5 6.5H15.5L14.5 17H5.5L4.5 6.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 6.5V5C7.5 3.62 8.62 2.5 10 2.5C11.38 2.5 12.5 3.62 12.5 5V6.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Calendar grid — clean 2x2 grid with top bar */
export function WeekIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2.5"
        y="3.5"
        width="15"
        height="14"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.5 7.5H17.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M6.5 2V5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M13.5 2V5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M10 7.5V17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M2.5 12.5H17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// HEADER ACTIONS
// -----------------------------------------------------------------------------

/** Gear/cog — simple, thin, 6 teeth */
export function SettingsIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M10 2.5V4.5M10 15.5V17.5M17.5 10H15.5M4.5 10H2.5M15.3 4.7L13.9 6.1M6.1 13.9L4.7 15.3M15.3 15.3L13.9 13.9M6.1 6.1L4.7 4.7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Share — arrow pointing out of a box */
export function ShareIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 12.5V3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 7L10 3.5L13.5 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 10.5V15.5C14 16.05 13.55 16.5 13 16.5H7C6.45 16.5 6 16.05 6 15.5V10.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Simple checkmark — confirmation tick */
export function CheckmarkIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 8.5L6.5 12L13 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// CHAT
// -----------------------------------------------------------------------------

/** Microphone — slim, elegant capsule shape */
export function MicIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="7.5"
        y="2.5"
        width="5"
        height="9"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 9.5C4.5 12.54 6.96 15 10 15C13.04 15 15.5 12.54 15.5 9.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 15V17.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Stop recording — rounded square */
export function StopIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="4.5"
        y="4.5"
        width="11"
        height="11"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Send arrow — points right, auto-flips in RTL */
export function SendIcon({ size = 18, rtl = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={rtl ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path
        d="M3.5 10H15"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 5.5L15.5 10L11 14.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Voice/sound wave — three vertical bars with varying heights */
export function VoiceWaveIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 8V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7.5 5.5V14.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 7V13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M14.5 4V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// LIST VIEWS — Empty States (larger, thinner)
// -----------------------------------------------------------------------------

/** Clipboard with checkmark — empty tasks state */
export function EmptyTasksIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="9"
        y="5"
        width="22"
        height="30"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 5V4C15 2.9 15.9 2 17 2H23C24.1 2 25 2.9 25 4V5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 20L18 23L25 16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.4"
      />
      <path d="M15 28H25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
      <path d="M15 31H21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.15" />
    </svg>
  );
}

/** Shopping bag outline — empty shopping state */
export function EmptyShoppingIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 11H32L30 36H10L8 11Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 11V9C14 5.69 16.69 3 20 3C23.31 3 26 5.69 26 9V11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 21H25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.3"
      />
      <path
        d="M15 25H22"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.2"
      />
    </svg>
  );
}

/** Calendar outline — empty calendar state */
export function EmptyCalendarIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="4"
        y="6"
        width="32"
        height="30"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 14H36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 3V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M28 3V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Subtle grid dots */}
      <circle cx="12" cy="21" r="1" fill="currentColor" opacity="0.2" />
      <circle cx="20" cy="21" r="1" fill="currentColor" opacity="0.2" />
      <circle cx="28" cy="21" r="1" fill="currentColor" opacity="0.2" />
      <circle cx="12" cy="28" r="1" fill="currentColor" opacity="0.15" />
      <circle cx="20" cy="28" r="1" fill="currentColor" opacity="0.15" />
    </svg>
  );
}

/** X mark — for delete actions */
export function DeleteIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 4L12 12M12 4L4 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Hand raise — "I'll do it" claim action */
export function ClaimIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 14.5V7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M8 7V3C8 2.45 8.45 2 9 2C9.55 2 10 2.45 10 3V6.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 7V2.5C8 1.95 7.55 1.5 7 1.5C6.45 1.5 6 1.95 6 2.5V7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 6.5V4.5C10 3.95 10.45 3.5 11 3.5C11.55 3.5 12 3.95 12 4.5V8.5C12 11.81 9.31 14.5 6 14.5H5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 7V4C6 3.45 5.55 3 5 3C4.45 3 4 3.45 4 4V9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Small X — remove assignment (compact) */
export function UnassignIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// WEEK VIEW — Navigation
// -----------------------------------------------------------------------------

/** Left chevron — week navigation */
export function ChevronLeftIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 3L5 8L10 13"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Right chevron — week navigation */
export function ChevronRightIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6 3L11 8L6 13"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------------------

/** Google "G" logo — full color brand mark */
export function GoogleIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M18.17 10.2C18.17 9.57 18.11 8.95 18.01 8.36H10V11.84H14.58C14.37 12.97 13.72 13.93 12.76 14.57V16.82H15.58C17.2 15.33 18.17 12.97 18.17 10.2Z"
        fill="#4285F4"
      />
      <path
        d="M10 19C12.43 19 14.47 18.15 15.58 16.82L12.76 14.57C11.95 15.12 10.89 15.44 10 15.44C7.65 15.44 5.67 13.93 4.96 11.87H2.06V14.19C3.54 17.12 6.55 19 10 19Z"
        fill="#34A853"
      />
      <path
        d="M4.96 11.87C4.78 11.32 4.68 10.73 4.68 10.13C4.68 9.53 4.78 8.94 4.96 8.39V6.07H2.06C1.39 7.4 1 8.92 1 10.13C1 11.34 1.39 12.86 2.06 14.19L4.96 11.87Z"
        fill="#FBBC05"
      />
      <path
        d="M10 4.82C11.17 4.82 12.11 5.23 12.87 5.98L15.62 3.23C14.46 2.14 12.43 1.26 10 1.26C6.55 1.26 3.54 3.14 2.06 6.07L4.96 8.39C5.67 6.33 7.65 4.82 10 4.82Z"
        fill="#EA4335"
      />
    </svg>
  );
}

/** Back arrow — left arrow, flips in RTL */
export function BackArrowIcon({ size = 16, rtl = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={rtl ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path
        d="M10 2.5L4.5 8L10 13.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// WELCOME SCREEN — Feature Icons (slightly larger, accent fills allowed)
// -----------------------------------------------------------------------------

/** Shopping list with items — feature highlight */
export function ShoppingFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="4"
        y="3"
        width="20"
        height="22"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* List items */}
      <circle cx="9" cy="10" r="1.2" fill={accent} />
      <path d="M12 10H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="15" r="1.2" fill={accent} />
      <path d="M12 15H18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="20" r="1.2" fill={accent} opacity="0.5" />
      <path d="M12 20H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

/** Calendar with a date — feature highlight */
export function CalendarFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="3"
        y="4"
        width="22"
        height="21"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 10H25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9 2V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M19 2V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Highlighted date square */}
      <rect x="11" y="14" width="6" height="6" rx="1.5" fill={accent} opacity="0.25" />
      <text
        x="14"
        y="19.5"
        textAnchor="middle"
        fontSize="6"
        fontWeight="600"
        fill={accent}
        fontFamily="sans-serif"
      >
        14
      </text>
    </svg>
  );
}

/** House with checkmark — chores feature highlight */
export function ChoresFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* House roof */}
      <path
        d="M4 13L14 4L24 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* House body */}
      <path
        d="M7 11V23C7 23.55 7.45 24 8 24H20C20.55 24 21 23.55 21 23V11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Checkmark inside house */}
      <path
        d="M10.5 17.5L13 20L18 14.5"
        stroke={accent}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Bell icon — reminders feature highlight */
export function ReminderFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Bell body */}
      <path
        d="M14 4C10.686 4 8 6.686 8 10V15C8 15.8 7.2 16.8 6 17.5H22C20.8 16.8 20 15.8 20 15V10C20 6.686 17.314 4 14 4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Clapper */}
      <path
        d="M12 20.5C12 21.6 12.9 22.5 14 22.5C15.1 22.5 16 21.6 16 20.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Top knob */}
      <circle cx="14" cy="4" r="1.2" fill={accent} />
    </svg>
  );
}

/** Sparkle icon — learning/AI feature highlight */
export function LearningFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Main 4-point sparkle */}
      <path
        d="M14 3L16 11L24 14L16 17L14 25L12 17L4 14L12 11Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Small accent sparkle */}
      <path
        d="M22 5L22.8 7.5L25 8.5L22.8 9.5L22 12L21.2 9.5L19 8.5L21.2 7.5Z"
        fill={accent}
        opacity="0.6"
      />
    </svg>
  );
}

/** Forward-to-task — corner-up-right arrow rising from an accent dot.
 *  Dot = the original WhatsApp message; curve + arrow = captured and forwarded
 *  into Sheli as a task. Used on the landing forward-to-task feature card. */
export function ForwardFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Curving line: bottom-left up, then right toward arrowhead */}
      <path
        d="M6 23v-9a4 4 0 0 1 4-4h12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Arrowhead ">" pointing right at (22,10) */}
      <path
        d="M17 14L22 10L17 6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Accent dot at origin — the source message being forwarded */}
      <circle cx="6" cy="23" r="1.8" fill={accent} opacity="0.8" />
    </svg>
  );
}

/** Two kids — chores & rotations for children */
export function KidsIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Left kid */}
      <circle cx="9.5" cy="9" r="2.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 22C5 18.69 6.97 16 9.5 16C12.03 16 14 18.69 14 22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Right kid */}
      <circle cx="18.5" cy="9" r="2.8" stroke={accent} strokeWidth="1.5" />
      <path d="M14 22C14 18.69 15.97 16 18.5 16C21.03 16 23 18.69 23 22" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Coin with shekel — expense tracking feature highlight */
export function ExpenseFeatureIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Coin circle */}
      <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="1.5" />
      {/* Shekel symbol ₪ simplified as two vertical lines with connecting strokes */}
      <path
        d="M10 9V17.5C10 18.88 11.12 20 12.5 20M18 19V10.5C18 9.12 16.88 8 15.5 8"
        stroke={accent}
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Three people — family group feature highlight */
export function FamilyGroupIcon({ size = 28 }) {
  const accent = 'var(--accent, #C4714A)';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Center person */}
      <circle cx="14" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 22C9 18.69 11.24 16 14 16C16.76 16 19 18.69 19 22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Left person (smaller) */}
      <circle cx="6.5" cy="11" r="2.2" stroke={accent} strokeWidth="1.3" opacity="0.7" />
      <path d="M3 22C3 19.5 4.57 17.5 6.5 17.5" stroke={accent} strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
      {/* Right person (smaller) */}
      <circle cx="21.5" cy="11" r="2.2" stroke={accent} strokeWidth="1.3" opacity="0.7" />
      <path d="M25 22C25 19.5 23.43 17.5 21.5 17.5" stroke={accent} strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// UTILITY — Additional commonly needed icons
// -----------------------------------------------------------------------------

/** Plus icon — for add buttons */
export function PlusIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 3V13M3 8H13"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Edit/pencil icon — for edit actions */
export function EditIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M11.5 2.5L13.5 4.5L5.5 12.5H3.5V10.5L11.5 2.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 4.5L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Receipt — for expenses tab */
export function ReceiptIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 2.5V17.5L6 16L8 17.5L10 16L12 17.5L14 16L16 17.5V2.5L14 4L12 2.5L10 4L8 2.5L6 4Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.5 8.5H12.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M7.5 11.5H10.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Heart icon — for favorites / love */
export function HeartIcon({ size = 16, filled = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 13.5C8 13.5 2 10 2 6C2 4.14 3.46 2.5 5.25 2.5C6.54 2.5 7.63 3.22 8 4.13C8.37 3.22 9.46 2.5 10.75 2.5C12.54 2.5 14 4.14 14 6C14 10 8 13.5 8 13.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

/** Calendar with sync arrows — for Google Calendar sync action.
 *  When `synced=true`, swaps the sync glyph for a checkmark.
 *  Stroke-based, currentColor — matches the Sheli icon system. */
export function CalendarSyncIcon({ size = 14, synced = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Calendar frame */}
      <rect
        x="2"
        y="3"
        width="12"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Date tabs (binder pins) */}
      <path d="M5.5 1.5V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.5 1.5V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Header divider */}
      <path d="M2 6.2H14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />

      {synced ? (
        /* Checkmark — confirmed/synced state */
        <path
          d="M5.4 10.6L7.2 12.3L10.7 8.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        /* Refresh / sync arrow — open arc + arrowhead */
        <>
          <path
            d="M10.6 9.6A2.5 2.5 0 1 0 10.9 12.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10.6 8.1V9.7H9.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
