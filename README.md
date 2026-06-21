# Escape the Cave

First-person procedural **voxel cave** survival/escape game — Computer Graphics final project.
You're trapped in a collapsed cave: manage your **light**, collect **3 key fragments**, and reach the **exit** while goblins lurk in the dark.

## ▶ Play in the browser

**https://i1uvmango.github.io/escape_the_cave_computerGraphics/**

> If the link 404s, the owner must enable GitHub Pages once:
> repo **Settings → Pages → Source = `main` branch / `/ (root)`**, then wait ~1 min.

## Highlights

- **Procedural voxel cave** (room + corridor carving), guaranteed walkable, baked to `cave.json`.
- **Surface Nets** smooth mesh from the voxel grid + **triplanar PBR** (Rock035, CC0).
- **Real-time DDGI** — irradiance probe grid ray-traced against the cave **BVH** (mesh + three-mesh-bvh), so glowstone/flashlight light bounces **around corners**.
- **Mixamo goblins** (FBX walk animation) that are **drawn to your flashlight** and attack in the dark.
- Flashlight **battery (3 min)**, placeable **glowstones**, hearts, compass, explored-route **map**, and a **tutorial stage**.

## Controls

| Input | Action |
|---|---|
| `WASD` | Move (`Shift+W` run) |
| `Space` | Jump |
| Mouse | Look |
| Left-click | Flashlight on/off |
| Right-click | Place glowstone |
| `F` | Pick up key (aim at it) |
| `M` | Map (explored route) |
| `B` | Music on/off |
| `Esc` | Release mouse |

## Run locally

No build tools — plain ES modules + a static server:

```bash
python3 -m http.server 8000
# Game:            http://localhost:8000/game.html
# Generator tool:  http://localhost:8000/generator.html
```

## Report

Full write-up: [report.md](report.md).

## Tech & credits

- **three.js** (WebGL2), **three-mesh-bvh** (collision), **lil-gui** (generator tool).
- Rock texture: **Rock035, ambientCG (CC0)**. Goblin: **Mixamo (Adobe)**. Flashlight model: AI-generated.
