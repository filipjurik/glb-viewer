# GLB Viewer

Lovelace karta pre Home Assistant, ktorá zobrazí 3D model domu (`.glb` / `.gltf`, napr. export zo SketchUpu) a prepojí ho s entitami: svetlá v miestnostiach, noc a tiene podľa skutočného slnka, pohľady kamery.

*Lovelace card for Home Assistant that shows a 3D model of a house (`.glb` / `.gltf`) and links it to entities: room lights, night mode and shadows from the real sun, camera views.*

## Inštalácia

### HACS
1. HACS → tri bodky vpravo hore → **Custom repositories**.
2. Zadaj `https://github.com/filipjurik/glb-viewer`, kategória **Dashboard**.
3. Nainštaluj **GLB Viewer** a obnov prehliadač (Ctrl+F5).

### Ručne
1. Skopíruj `glb-viewer.js` do `/config/www/community/glb-viewer/`.
2. Nastavenia → Dashboardy → ⋮ → Zdroje → pridaj `/local/community/glb-viewer/glb-viewer.js` ako **JavaScript modul**.

Model ulož napr. do `/config/www/dom/dom.glb` (v HA dostupný ako `/local/dom/dom.glb`).

## Použitie

```yaml
type: custom:dom-viewer-card
model: /local/dom/dom.glb
height: 500px
night: sun
front_azimuth: 180
lights:
  - name: obyvacka
    entities:
      - light.obyvacka
    position: [2.3, 2.25, 4]
    intensity: 20
    windows: obyvacka
```

Kartu je najjednoduchšie nastaviť vizuálnym editorom. Three.js sa načítava z CDN (`esm.sh`), karta preto potrebuje internet; inú adresu možno nastaviť cez `three_url`.

## Hlavné možnosti

| Možnosť | Popis |
| --- | --- |
| `model` | cesta k `.glb` / `.gltf` |
| `height`, `width`, `background`, `hide_border` | vzhľad karty |
| `model_yaw`, `model_pitch`, `model_roll`, `flip_x`, `flip_z` | orientácia modelu |
| `min/max/initial_tilt`, `min/max/initial_azimuth`, `min/max/initial_zoom` | limity a štart kamery |
| `enable_pan` | posúvanie pohľadu |
| `auto_rotate`, `rotation_per_second`, `show_play_button` | automatické otáčanie (s limitmi sa otáča tam a späť) |
| `night` | `off` / `on` / `sun` (podľa `sun.sun`) / `entity` |
| `night_ambient` | minimálny jas scény v noci (0 – 1) |
| `front_azimuth` | svetová strana, na ktorú smeruje predná strana modelu (0 = sever, 180 = juh) |
| `shadow_intensity` | tieň na zemi pod domom (0 = vypnuté, tiene na modeli ostanú) |
| `lights_shadows`, `lights_test` | tiene zo svetiel / zapnutie všetkých svetiel (test) |
| `window_glow` | žiara okien pri zapnutom svetle |
| `hidden_materials`, `material_colors`, `views` | skryté plochy, farby a priehľadnosť materiálov, pohľady kamery |

### Svetlá (`lights`)

`name`, `entities` (viac entít), `position: [x, y, z]` (metre v súradniciach modelu), `color`, `intensity`, `distance`, `shadows` (tieň majú najviac 6 práve zapnutých svetiel), `use_entity_color`, `use_brightness`, `disabled` (nepoužije sa, ostane uložené), `glow_only` (svetlo neosvetľuje model, iba rozžiari okno), `windows` (okná, ktoré pri svetle svietia), `window_entity_color`.

### Okná a materiály

Okno sa rozpozná podľa materiálu s názvom `okno_`, `sklo_`, `window_` alebo `glass_` + názov miestnosti (v `windows` sa uvádza len názov miestnosti). V editore sa v zoznamoch materiálov zobrazujú materiály s predponami `wall_`, `roof_`, `window_`, `glass_`, `color_`, `floor_`, `door_`; ostatné sa dajú zapnúť voľbou „ostatné“.

## Tipy k exportu zo SketchUpu

Model exportuj ako glTF (Y-up). Ak je dom otočený alebo zrkadlový, oprav to v karte (`model_yaw`, `flip_x`).
