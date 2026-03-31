# Spec 9: Single-Page Dashboard

## Overview
Consolidate the upload → analysis → letter flow into a single `/dashboard`
page with tabs. Users never leave the dashboard during normal use.

---

## Tabs

Three tabs in the dashboard:

| Tab | Description |
|-----|-------------|
| New Bill | Upload form. Default tab on login. |
| Analysis | Inline results of the most recently analyzed bill. Disabled until a bill has been analyzed or loaded from history. |
| History | List of all past analyzed bills. Clicking one loads it into the Analysis tab. |

---

## New Bill Tab

Same upload form as today — state dropdown, county input, file drop zone,
Analyze button. When analysis completes, automatically switch to the
Analysis tab and display results. No page navigation.

---

## Analysis Tab

Two-column layout.

**Left column**
- Risk badge
- Recoverable amount header
- Summary text
- Issue cards (same `IssueCard` component)

**Right column**
- Letter panel
- Starts empty with a "Generate dispute letter" button
- When clicked, letter appears inline in the same panel
- Copy and Download PDF buttons appear below the letter once generated
- No page navigation at any point

The tab is grayed out and non-interactive until at least one analysis has
been loaded in the session (either from a fresh upload or selected from
History).

---

## History Tab

On tab focus, fetch the user's past analyzed documents from Supabase.
Display as a scrollable list. Each row shows:
- File name
- Date analyzed
- Risk level indicator
- Recoverable amount (if any)

Clicking a row:
1. Loads that bill's analysis into the Analysis tab
2. Switches to the Analysis tab
3. If a letter was previously generated for that analysis, load and display
   it automatically in the letter panel

---

## Unchanged

- `/analysis/[id]` route — remains functional for direct URL access
- `/letter/[id]` route — remains functional for direct URL access
- `/upload` route — remains functional and untouched
- `UploadZone` component existing behavior — unchanged on `/upload`

---

## Implementation Notes

- The upload zone component should accept an optional `onSuccess` callback
  prop. When provided, call it with the analysis result and analysis ID
  instead of navigating to `/analysis/[id]`. When not provided, existing
  behavior is preserved.
- The dashboard should be a client component that manages `activeTab`,
  `currentAnalysis`, `currentAnalysisId`, and `currentLetter` as state.
- Letter generation should call `/api/generate-letter` then fetch the
  letter content from Supabase and set it in state — no navigation.
- History data should be fetched from Supabase client-side on tab focus,
  not on page load.