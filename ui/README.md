# Quiet

A minimal interface kit for every app: no borders, no boxes, no permanent
helper text. Text shows up when it is needed and goes away when it is not.

Copy `quiet.css` and `quiet.js` into an app and load them:

```html
<link rel="stylesheet" href="quiet.css">
<script src="quiet.js" defer></script>
```

Open `index.html` to try it.

## Rules

1. **Labels live in the placeholder.** Once you type, a small label floats in
   above the field so you never lose track of what it was.
2. **Hints only while focused.** `.q-hint` appears when you are in the field.
3. **Errors only after a mistake.** `.q-error` appears once a field is
   `:user-invalid` (after you leave it or submit), never on a fresh form.
4. **Actions only where you are.** `.q-reveal` buttons in a list row show on
   hover or focus. On touch screens they stay visible.
5. **Icons name themselves on demand.** `data-tip="Rename"` shows the word
   after a short hover or on keyboard focus.
6. **Chrome gets out of the way.** Anything with `data-chrome` (nav, toolbars)
   fades after 2.5 s of no input and returns on any movement.
   `<html data-idle="0">` turns this off; any other number sets the delay in ms.
7. **Feedback leaves by itself.** `quiet.say('Saved')` shows one line, then goes.
8. **No dialogs for "are you sure".** `data-confirm="Remove?"` on a text
   button makes the first click ask and the second click act.
9. **Busy without words.** `quiet.busy(button, () => fetch(...))` makes the
   button breathe while the work runs.

## Pieces

| Class / attribute | What it is |
| --- | --- |
| `.q-page` | Single centred column, 640 px max |
| `.q-stack`, `.q-row`, `.q-grow` | Vertical gap, horizontal row, flexible filler |
| `button`, `.q-btn`, `.q-primary` | Text buttons; primary is just bolder |
| `.q-field` > `label` + `input` + `.q-hint` + `.q-error` | Field (input needs a `placeholder`; wrap hint/error text in a `<span>`) |
| `.q-switch` | Checkbox drawn as a switch |
| `.q-list` with `data-empty="…"` | List; shows the empty text only when it has no rows |
| `.q-bar` | Top bar holding a `nav` and icon buttons |
| `.q-muted`, `.q-sr` | Quiet text; screen-reader-only text |

Colours are five tokens (`--q-bg`, `--q-text`, `--q-muted`, `--q-line`,
`--q-hover`) plus `--q-bad` for errors. Light and dark follow the system;
`<html data-theme="dark|light">` forces one. Motion is turned off for people
who ask for reduced motion.
