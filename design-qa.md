# AutoLabOS WebUI Design QA

## Source of truth

- Selected visual target: `.playwright-cli/design-target.png`
- Final implementation capture: `.playwright-cli/design-implementation-desktop.png`
- Full-view side-by-side comparison: `.playwright-cli/design-comparison.png`
- Responsive evidence:
  - `.playwright-cli/design-tablet-activity.png`
  - `.playwright-cli/design-mobile-default.png`
  - `.playwright-cli/design-mobile-workflow.png`
  - `.playwright-cli/design-mobile-activity.png`
  - `.playwright-cli/design-mobile-details.png`

The `.playwright-cli` files are transient, ignored QA artifacts. The shipped source of truth remains the React and CSS implementation.

## Capture contract

- Desktop source pixels: 1487 x 1058
- Desktop implementation pixels: 1487 x 1058
- Browser CSS viewport: 1487 x 1058
- Device scale factor: 1
- Desktop state: persisted review node, approval required, Activity open, Details disclosure open
- Responsive states: default workbench, Workflow modal, Activity modal, and Run details modal
- Validation fixture boundary: no governed action, provider request, or research node was executed

## Full-view comparison

The selected target and browser implementation were compared together at the same resolution in `.playwright-cli/design-comparison.png`.

Five fidelity surfaces were checked explicitly:

1. Shell geometry: the target workflow/main/activity widths are approximately 268/891/328 pixels; the implementation is 260/907/320 pixels. The implementation uses the full 1487-pixel viewport without horizontal overflow.
2. Navigation hierarchy: all ten governed workflow nodes remain visible, with one current step and restrained status coloring.
3. Decision workspace: the decision question, evidence rows, drill-down actions, and recent activity remain readable in the main pane without a permanent Inspector column.
4. Utility surfaces: Activity and Details are mutually exclusive when modal, preserve their semantic labels, and return focus to the exact invoking control.
5. Action hierarchy: the bottom dock occupies layout space instead of covering content and exposes one state-appropriate primary mutation.

## Focused evidence

Separate responsive captures were necessary because a single desktop screenshot cannot prove the following interaction states:

- 390 x 844 default: document and main scroll widths both equal 390 pixels; the Activity trigger is 40 x 40 pixels.
- 390 x 844 Workflow: all ten nodes are visible in one full-height sheet and the action dock is removed from the rendered layout while the sheet is open.
- 390 x 844 Activity: the drawer is a labelled modal dialog from y=64 to y=844, background regions are inert, the backdrop is non-focusable, and the dock is hidden.
- 390 x 844 Run details: the modal locks body scroll, focuses its heading, traps keyboard focus, and retains all eight inspector destinations.
- 800 x 900 and 1024 x 900 Activity: the 320-pixel drawer remains modal with no document overflow or underlying action dock.
- 1321 x 900 Activity: the drawer becomes non-modal only when the three-column shell fits; both document and main scroll widths equal their client widths.

## Findings and resolutions

- Competing permanent columns reduced the decision workspace and caused controls to become hidden at narrower widths. Resolved by using one central decision workspace, a governed workflow rail, and one optional Activity/Details utility surface.
- Retry, approve, apply, run, and cancel affordances competed across several cards. Resolved with a single Next action presenter keyed to active-target and node state.
- Missing or not-yet-run evidence was projected as a blocker. Resolved by keeping unmeasured, awaiting-execution, and not-started states neutral until a real failing gate exists.
- Active-session intervention, plan, log, and busy state leaked into an inspected inactive run. Resolved by scoping run-specific surfaces to the active command target.
- Tablet drawers could cover narrow main content without modal isolation. Resolved by keeping Activity modal through 1320 pixels and enabling the desktop third column at 1321 pixels.
- Keyboard and screen-reader contracts were incomplete. Resolved with disclosure navigation, labelled dialogs, focus trapping/return, inert background content, roving inspector tabs, visible focus rings, and AA foreground tokens.

## Iteration history

1. Replaced the previous left composer plus narrow main plus permanent inspector layout with the selected editorial operations shell.
2. Moved the guided new-run workflow into the main task area and retained run discovery in the top context bar.
3. Consolidated workflow mutations into the bottom Next action dock and moved advanced evidence/operations into Details and Activity.
4. Corrected mobile sheet height, trigger iconography, dock visibility, focus isolation, and touch-target sizing.
5. Corrected tablet overlay behavior at 800/1024 pixels and verified the 1320/1321 modal-to-column boundary.
6. Corrected evidence semantics, active-run isolation, exact invoker focus return, accessible run selection, color contrast, and focus visibility.
7. Re-ran the full-resolution side-by-side review and responsive browser measurements after the final code changes.

## Result

No blocking visual, interaction, overflow, or accessibility mismatch remained in the tested states.

final result: passed
