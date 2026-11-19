# GLB Viewer

A Lovelace card for Home Assistant that shows a 3D model of your house (`.glb` / `.gltf`, e.g. exported from SketchUp) and links it to your entities: room lights, night mode and shadows driven by the real sun, camera views.

## Live demo

https://filipjurik.github.io/glb-viewer/ – the card running on a model of a real house, with a time-of-day slider (sun position, night mode, shadows) and a switch for all lights. The demo page lives in `docs/`.

## Installation

### HACS
1. HACS → three dots (top right) → **Custom repositories**.
2. Enter `https://github.com/filipjurik/glb-viewer`, category **Dashboard**.
3. Install **GLB Viewer** and refresh the browser (Ctrl+F5).

### Manual
1. Copy `glb-viewer.js` to `/config/www/community/glb-viewer/`.
2. Settings → Dashboards → ⋮ → Resources → add `/local/community/glb-viewer/glb-viewer.js` as a **JavaScript module**.

Put your model e.g. at `/config/www/dom/dom.glb` (available in HA as `/local/dom/dom.glb`).

## Usage

```yaml
type: custom:dom-viewer-card
model: /local/dom/dom.glb
height: 500px
night: sun
front_azimuth: 180
lights:
  - name: livingroom
    entities:
      - light.livingroom
    position: [2.3, 2.25, 4]
    intensity: 20
    windows: livingroom
```

The easiest way to configure the card is the visual editor. Three.js is loaded from a CDN (`esm.sh`), so the card needs internet access; another URL can be set with `three_url`.

## Main options

| Option | Description |
| --- | --- |
| `model` | path to the `.glb` / `.gltf` file |
| `height`, `width`, `background`, `hide_border` | card appearance |
| `model_yaw`, `model_pitch`, `model_roll`, `flip_x`, `flip_z` | model orientation |
| `min/max/initial_tilt`, `min/max/initial_azimuth`, `min/max/initial_zoom` | camera limits and start position |
| `enable_pan` | panning of the view |
| `auto_rotate`, `rotation_per_second`, `show_play_button` | auto-rotate (with azimuth limits it swings back and forth) |
| `night` | `off` / `on` / `sun` (follows `sun.sun`) / `entity` |
| `night_ambient` | minimum scene brightness at night (0 – 1) |
| `front_azimuth` | compass direction the front of the model faces (0 = north, 180 = south) |
| `shadow_intensity` | ground shadow under the house (0 = off, shadows on the model stay) |
| `lights_shadows`, `lights_test` | shadows from lights / turn on all lights (test) |
| `window_glow` | window glow when the light is on |
| `hidden_materials`, `material_colors`, `views` | hidden surfaces, material colors and transparency, camera views |

### Lights (`lights`)

`name`, `entities` (several entities allowed), `position: [x, y, z]` (meters in model coordinates), `color`, `intensity`, `distance`, `shadows` (at most 6 currently lit lights get a shadow), `use_entity_color`, `use_brightness`, `disabled` (not used, stays saved), `glow_only` (the light does not illuminate the model, it only makes the window glow), `windows` (windows that glow with this light), `window_entity_color`.

### Windows and materials

A window is recognized by a material named `window_` or `glass_` + room name (in `windows` you enter just the room name). In the editor, the material lists show materials with the prefixes `wall_`, `roof_`, `window_`, `glass_`, `color_`, `floor_`, `door_`; other materials can be shown with the “other” option.

## SketchUp export tips

Export the model as glTF (Z-up). If the house comes out rotated or mirrored, fix it in the card (`model_yaw`, `flip_x`).

## Support

If you like this card, you can support its development: [paypal.me/fijur76](https://paypal.me/fijur76)
