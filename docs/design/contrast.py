#!/usr/bin/env python3
"""WCAG 2.1 contrast check for PPEC design tokens. Run: python3 docs/design/contrast.py"""
T = {"bg":"#F8FAFC","surface":"#FFFFFF","ink":"#0F172A","ink-muted":"#475569","border-strong":"#64748B",
 "brand":"#1D4ED8","focus":"#1D4ED8",
 "ok-fg":"#166534","ok-bg":"#DCFCE7","info-fg":"#1E40AF","info-bg":"#DBEAFE",
 "warn-fg":"#854D0E","warn-bg":"#FEF9C3","crit-fg":"#991B1B","crit-bg":"#FEE2E2",
 "neutral-fg":"#334155","neutral-bg":"#E2E8F0","demo-fg":"#FFFFFF","demo-bg":"#6D28D9","src-sim":"#6D28D9",
 "map-truck-ok":"#15803D","map-truck-stale":"#A16207","map-truck-crit":"#B91C1C",
 # OpenFreeMap positron basemap fills (tiles.openfreemap.org/styles/positron, read 2026-10-14)
 "osm-bg":"#F2F3F0","osm-park":"#E6E9E5","osm-resid":"#EAEAE6","osm-wood":"#DCE0DC","osm-road":"#D5D5D5","osm-water":"#D9E2E7",  # override: positron water rgb(194,200,202) #C2C8CA failed 3:1 for ok/stale trucks (2.96, 2.91)
 "route":"#1D4ED8","center-pin":"#0F172A"}
def L(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def R(a,b):
    a,b=L(T[a]),L(T[b]); return (max(a,b)+0.05)/(min(a,b)+0.05)
P=[("ink","bg",4.5),("ink","surface",4.5),("ink-muted","surface",4.5),("ink-muted","bg",4.5),
 ("border-strong","surface",3),("brand","surface",4.5),("surface","brand",4.5),("focus","surface",3),("focus","bg",3),
 ("ok-fg","ok-bg",4.5),("info-fg","info-bg",4.5),("warn-fg","warn-bg",4.5),("crit-fg","crit-bg",4.5),
 ("neutral-fg","neutral-bg",4.5),("demo-fg","demo-bg",4.5),
 ("ok-fg","surface",4.5),("warn-fg","surface",4.5),("crit-fg","surface",4.5),
 ("src-sim","surface",4.5),("src-sim","bg",4.5),("ink-muted","surface",4.5),("ink","surface",4.5),("border-strong","bg",3),
 ("map-truck-ok","surface",3),("map-truck-stale","surface",3),("map-truck-crit","surface",3),
 # non-text 3:1: map markers, route line, center pin vs basemap fills
 ("map-truck-ok","osm-bg",3),("map-truck-ok","osm-park",3),("map-truck-ok","osm-resid",3),("map-truck-ok","osm-wood",3),("map-truck-ok","osm-road",3),("map-truck-ok","osm-water",3),("map-truck-stale","osm-bg",3),("map-truck-stale","osm-park",3),("map-truck-stale","osm-resid",3),("map-truck-stale","osm-wood",3),("map-truck-stale","osm-road",3),("map-truck-stale","osm-water",3),("map-truck-crit","osm-bg",3),("map-truck-crit","osm-park",3),("map-truck-crit","osm-resid",3),("map-truck-crit","osm-wood",3),("map-truck-crit","osm-road",3),("map-truck-crit","osm-water",3),("route","osm-bg",3),("route","osm-park",3),("route","osm-resid",3),("route","osm-wood",3),("route","osm-road",3),("route","osm-water",3),("center-pin","osm-bg",3),("center-pin","osm-park",3),("center-pin","osm-resid",3),("center-pin","osm-wood",3),("center-pin","osm-road",3),("center-pin","osm-water",3)]
bad=0
print("| Foreground | Background | Ratio | Needs | Result |\n|---|---|---|---|---|")
for f,b,n in P:
    r=R(f,b); ok=r>=n; bad+=not ok
    print(f"| {f} `{T[f]}` | {b} `{T[b]}` | {r:.2f}:1 | {n}:1 | {'PASS' if ok else 'FAIL'} |")
raise SystemExit(bad)
