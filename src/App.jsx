import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import jsPDF from "jspdf";

// Excel "Accounting"/"Number" formats export negatives as "(16.95)" and thousands as
// "2,200.00"; CAD exports may use a Unicode minus. Plain unary + turns all of these into
// NaN → 0, silently zeroing coordinates and weights.
function parseNumericCell(raw) {
  let s = String(raw ?? "").trim().replace(/[\s,$ ]/g, "").replace(/[−‒-―﹣－]/g, "-");
  const isParenNegative = /^\(.*\)$/.test(s);
  if (isParenNegative) s = s.slice(1, -1);
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return isParenNegative ? -Math.abs(n) : n;
}

function parseUploadedFile(arrayBuffer) {
  const text = new TextDecoder().decode(arrayBuffer);
  const result = Papa.parse(text, { header: false, skipEmptyLines: true });
  return result.data || [];
}

// ============================================================
// COORDINATE SYSTEM:
// X = Lateral. Origin = left tipping edge.
// Y = Longitudinal. Origin = front tipping point. Negative = forward.
// Z = Vertical. Origin = ground. Positive = up.
// ============================================================

// Arm rotation: from spreadsheet "Rotation Arm Length Calcs"
// arm_length = sqrt((pivotY - restY)^2 + (restZ - pivotZ)^2)
// new_Y = pivotY - arm_length * cos(θ + π/2)
// new_Z = pivotZ + arm_length * sin(θ)
function getSwiveledPosition(restX, restY, pivX, pivY, angleDeg) {
  const dX = restX - pivX, dY = restY - pivY;
  const rad = angleDeg * Math.PI / 180;
  return { x: pivX + dX * Math.cos(rad) - dY * Math.sin(rad), y: pivY + dX * Math.sin(rad) + dY * Math.cos(rad) };
}

function getRotatedPosition(restY, restZ, pivotY, pivotZ, angleDeg) {
  const dY = restY - pivotY;
  const dZ = restZ - pivotZ;
  const rad = (angleDeg * Math.PI) / 180;
  return {
    y: pivotY + dY * Math.cos(rad) - dZ * Math.sin(rad),
    z: pivotZ + dY * Math.sin(rad) + dZ * Math.cos(rad),
  };
}

function getEffPos(c, geo, armAngle, armIds, liftHeight = 0, liftIds = new Set(), swivelAngle = 0) {
  let { x, y, z } = c;
  if (liftIds.has(c.id) && liftHeight !== 0) {
    y = c._restY ?? y;
    z = (c._restZ ?? z) + liftHeight;
    return { x, y, z };
  }
  if (armIds.has(c.id)) {
    if (geo.liftType === "vertical" && armAngle !== 0) {
      y = c._restY ?? y;
      z = (c._restZ ?? z) + armAngle;
    } else if (geo.armPivotY === 0 && geo.hopperPivotY !== 0) {
      // Buggy dump components: translate up with lift, then rotate about elevated pivot.
      const restY = c._restY ?? y;
      const restZ = (c._restZ ?? z) + liftHeight;
      if (armAngle !== 0) {
        const pivZ = geo.hopperPivotZ + liftHeight;
        const r = getRotatedPosition(restY, restZ, geo.hopperPivotY, pivZ, -armAngle);
        y = r.y; z = r.z;
      } else {
        y = restY; z = restZ;
      }
    } else if (armAngle !== 0) {
      const r = getRotatedPosition(c._restY ?? y, c._restZ ?? z, geo.armPivotY, geo.armPivotZ, armAngle);
      y = r.y; z = r.z;
    }
    if (swivelAngle !== 0 && geo.swivelPivotY != null) {
      const s = getSwiveledPosition(x, y, geo.width / 2, geo.swivelPivotY, -swivelAngle);
      x = s.x; y = s.y;
    }
  }
  return { x, y, z };
}

function computeStability(comps, geo, armAngle, armIds, overrides, liftHeight = 0, liftIds = new Set(), swivelAngle = 0) {
  const { wheelbase, width } = geo;
  let tW = 0, sX = 0, sY = 0, sZ = 0;
  comps.forEach(c => {
    if (!c.enabled || c.weight === 0) return;
    let p = getEffPos(c, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle);
    if (overrides?.[c.id]) { p.y = overrides[c.id].y; p.z = overrides[c.id].z; }
    tW += c.weight; sX += c.weight * p.x; sY += c.weight * p.y; sZ += c.weight * p.z;
  });
  if (tW === 0) return null;
  const cgX = sX / tW, cgY = sY / tW, cgZ = sZ / tW, D = 180 / Math.PI;
  if (cgZ <= 0) return null;
  const fwdTip = Math.atan(Math.abs(cgY) / cgZ) * D;
  const rearTip = Math.atan((wheelbase - Math.abs(cgY)) / cgZ) * D;
  const leftTip = Math.atan(cgX / cgZ) * D;
  const rightTip = Math.atan((width - cgX) / cgZ) * D;
  const pF = wheelbase ? (wheelbase + cgY) / wheelbase : 0.5;
  const pL = width ? 1 - cgX / width : 0.5;
  const fW = tW * pF, rW = tW - fW;
  return { totalW: tW, cgX, cgY, cgZ, fwdTip, rearTip, leftTip, rightTip, pctFront: pF, pctLeft: pL, frontW: fW, rearW: rW, fl: fW * pL, fr: fW * (1 - pL), rl: rW * pL, rr: rW * (1 - pL) };
}

// ROC: from spreadsheet "ROC Calc" section
// 1. CG without "Load", arms at max reach
// 2. startAngle = atan(cgZ / |cgY|), rotArm = sqrt(cgY^2+cgZ^2)
// 3. Rotate 10° further
// 4. ROC = k * (-(wNoLoad * rotatedCgY) / loadCgY_at_max_reach)
function computeROC(comps, geo, armIds, k) {
  if (!k) return null;
  const load = comps.find(c => c.enabled && c.name === "Load");
  if (!load) return null;
  let maxAngle;
  if (geo.liftType === "vertical") {
    const armRestZs = comps.filter(c => c.enabled && armIds.has(c.id)).map(c => c._restZ ?? c.z);
    if (armRestZs.length === 0) return null;
    maxAngle = Math.max(0, geo.maxPinHeight - Math.min(...armRestZs));
  } else {
    maxAngle = geo.maxPinHeight > 0
      ? Math.asin(Math.min(1, (geo.maxPinHeight - geo.armPivotZ) / Math.max(1, Math.sqrt(geo.armPivotY ** 2 + (geo.maxPinHeight - geo.armPivotZ) ** 2)))) * (180 / Math.PI)
      : 45;
  }
  let wNL = 0, myNL = 0, mzNL = 0;
  comps.forEach(c => {
    if (!c.enabled || c.name === "Load" || c.weight === 0) return;
    const p = getEffPos(c, geo, maxAngle, armIds);
    wNL += c.weight; myNL += c.weight * p.y; mzNL += c.weight * p.z;
  });
  if (wNL === 0) return null;
  const cgY = myNL / wNL, cgZ = mzNL / wNL;
  if (Math.abs(cgY) < 0.001) return null;
  const sa = Math.atan(cgZ / Math.abs(cgY));
  const ra = Math.sqrt(cgY * cgY + cgZ * cgZ);
  const rCgY = -ra * Math.cos(sa + 10 * Math.PI / 180);
  const lP = getEffPos(load, geo, maxAngle, armIds);
  if (lP.y === 0) return null;
  const mTip = -(wNL * rCgY) / lP.y;
  return { roc: Math.max(0, k * mTip), mTip, maxAngle: maxAngle.toFixed(1) };
}

function computeWeightSens(comps, geo, armAngle, armIds, selId, steps, inc, type, liftHeight = 0, liftIds = new Set(), swivelAngle = 0) {
  const half = Math.floor(steps / 2);
  const comp = comps.find(c => c.id === selId);
  if (!comp) return { vals: [], labels: [] };
  const labels = [], vals = [];
  for (let i = -half; i <= half; i++) {
    labels.push(Math.max(0, (comp.weight || 0) + i * inc));
    const m = comps.map(c => c.id === selId ? { ...c, weight: Math.max(0, c.weight + i * inc) } : c);
    const r = computeStability(m, geo, armAngle, armIds, undefined, liftHeight, liftIds, swivelAngle);
    vals.push(r ? (type === "rear" ? r.rearTip : r.fwdTip) : null);
  }
  return { vals, labels };
}

// 2D sensitivity heatmap: sweep selected component's Y and Z over a steps×steps grid.
// Returns fwdGrid and rearGrid, individual min/max, and shared globalMin/globalMax.
function computeHeatmap(comps, geo, armAngle, armIds, selId, steps, inc, liftHeight = 0, liftIds = new Set(), swivelAngle = 0) {
  const half = Math.floor(steps / 2);
  const comp = comps.find(c => c.id === selId);
  if (!comp) return null;
  const basePos = getEffPos(comp, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle);
  const cY = basePos.y, cZ = basePos.z;
  const fwdGrid = [], rearGrid = [];
  let fwdMin = Infinity, fwdMax = -Infinity, rearMin = Infinity, rearMax = -Infinity;
  // row = Z axis (top=+Z), col = Y axis (left=most-negative Y)
  for (let ri = 0; ri < steps; ri++) {
    const dZ = (half - ri) * inc;
    const rowZ = Math.max(0.01, cZ + dZ);
    for (let ci = 0; ci < steps; ci++) {
      const dY = (ci - half) * inc;
      const rowY = cY + dY;
      const ov = { [selId]: { y: rowY, z: rowZ } };
      const r = computeStability(comps, geo, armAngle, armIds, ov, liftHeight, liftIds, swivelAngle);
      const fv = r ? r.fwdTip : null;
      const rv = r ? r.rearTip : null;
      fwdGrid.push(fv);
      rearGrid.push(rv);
      if (fv !== null) { if (fv < fwdMin) fwdMin = fv; if (fv > fwdMax) fwdMax = fv; }
      if (rv !== null) { if (rv < rearMin) rearMin = rv; if (rv > rearMax) rearMax = rv; }
    }
  }
  const globalMin = Math.min(fwdMin, rearMin);
  const globalMax = Math.max(fwdMax, rearMax);
  return { fwdGrid, rearGrid, steps, inc, fwdMin, fwdMax, rearMin, rearMax, globalMin, globalMax, cY, cZ };
}

const MACHINES = [
  { id: "tx550", name: "Dingo TX 450/TX 550", type: "Crawler Loader", standard: "ISO 14397-1", k: 0.35, hasArm: true },
  { id: "tx1000", name: "Dingo TX 1000", type: "Crawler Loader", standard: "ISO 14397-1", k: 0.35, hasArm: true, liftType: "vertical" },
  { id: "txe750", name: "eDingo TX 750", type: "Crawler Loader", standard: "ISO 14397-1", k: 0.35, hasArm: true },
  { id: "edingo500", name: "e-Dingo 500", type: "Wheeled Loader", standard: "ISO 14397-1", k: 0.50, hasArm: true },
  { id: "2500t", name: "Ultra Buggy 2500-T", type: "Burden Carrier", standard: "ANSI B56.8", k: null, hasArm: false },
  { id: "2500ts", name: "Ultra Buggy 2500-TS", type: "Burden Carrier", standard: "ANSI B56.8", k: null, hasArm: false, hasSwivel: true },
  { id: "e2500", name: "Ultra Buggy e2500", type: "Burden Carrier", standard: "ANSI B56.8", k: null, hasArm: false },
  { id: "e2500ts", name: "Ultra Buggy e2500-TS", type: "Burden Carrier", standard: "ANSI B56.8", k: null, hasArm: false, hasSwivel: true },
  { id: "e2500thl", name: "Ultra Buggy e2500-THL", type: "Burden Carrier", standard: "ANSI B56.8", k: null, hasArm: false, hasLift: true },
  { id: "custom", name: "Custom Machine", type: "Custom", standard: "Custom", k: null, hasArm: false },
];

// Machine image calibration: fractions of image width/height for key reference points.
// frontAxle/rearAxle = X fraction of image width where the track-ground contact endpoints are
//   (the points where the track deviates from the ground plane — NOT the sprockets).
// groundY = Y fraction of image height where the track bottom (ground contact surface) is.
// imgW/imgH = natural pixel dimensions of the source image.
// Tune these until the FRT/REAR tipping-point circles land on the correct track endpoints.
const MACHINE_CAL = {
  tx1000:    { img: "/machines/TX1000_no background.png",        imgW: 664, imgH: 374, frontAxle: 0.605, rearAxle: 0.33, groundY: 0.84,  tilt: 0.5, zoomMult: 1.25, placerZoomMult: 0.85  },
  // TX450/TX550: 900×900px. frontAxle/rearAxle are fractions of image width where the track
  // leaves the ground plane. Tune until tipping-point circles align with track contact endpoints.
  tx550:     { img: "/machines/TX450_no background.png",         imgW: 900, imgH: 900, frontAxle: 0.625, rearAxle: 0.32, groundY: 0.715, tilt: 0, zoomMult: 1.25,  placerZoomMult: 0.65 },
  // Remaining machines — initial estimated fractions, tune visually after first render.
  txe750:    { img: "/machines/TXe750_no background.png",        imgW: 580, imgH: 388, frontAxle: 0.60, rearAxle: 0.20, groundY: 0.85,  tilt: -0.5, zoomMult: 1.65,  placerZoomMult: 0.8  },
  edingo500: { img: "/machines/eDingo500_no background.png",     imgW: 646, imgH: 430, frontAxle: 0.56, rearAxle: 0.245, groundY: 0.96,  tilt: 0, zoomMult: 1.6,  placerZoomMult: 1.0  },
  "2500t":   { img: "/machines/2500-T_no background.png",        imgW: 488, imgH: 257, frontAxle: 0.70, rearAxle: 0.33, groundY: 0.953, tilt: 0, zoomMult: 1.7,  placerZoomMult: 0.85  },
  "2500ts":  { img: "/machines/2500-TS_no background.png",       imgW: 422, imgH: 212, frontAxle: 0.67, rearAxle: 0.33, groundY: 0.94,  tilt: 0, zoomMult: 1.9,  placerZoomMult: 1.0  },
  e2500:     { img: "/machines/e2500_no background.png",         imgW: 939, imgH: 506, frontAxle: 0.68, rearAxle: 0.31, groundY: 0.93,  tilt: -2.6, zoomMult: 1.6,  placerZoomMult: 1.0  },
  e2500ts:   { img: "/machines/e2500-TS_no background.png",      imgW: 928, imgH: 476, frontAxle: 0.74, rearAxle: 0.40, groundY: 0.99,  tilt: 0, zoomMult: 1.75,  placerZoomMult: 1.0  },
  // e2500-THL: imgUp/imgUpW/imgUpH used when liftHeight > 0.
  e2500thl:  { img: "/machines/e2500-THL_down_no background.png", imgW: 873, imgH: 499, frontAxle: 0.70, rearAxle: 0.365, groundY: 0.98, tilt: 0, zoomMult: 1.6,  placerZoomMult: 0.9,
               imgUp: "/machines/e2500-THL_up_no background.png", imgUpW: 720, imgUpH: 720, frontAxleUp: 0.63, rearAxleUp: 0.365, groundYUp: 0.84, zoomMultUp: 0.85, placerZoomMultUp: 0.80 },
};

// Prefix public assets with Vite's base so paths resolve under /sws-stability-tool/.
// Data URLs (user-uploaded Custom images) are already self-contained — pass through.
const assetUrl = (path) => path.startsWith("data:") ? path : import.meta.env.BASE_URL + path.replace(/^\//, "");

// Single source for overlay calibration. Custom has no static entry — its calibration is
// user-generated (same shape as MACHINE_CAL) and lives in per-machine state.
const resolveMachineCal = (machineId, customCal = null) =>
  machineId === "custom" ? customCal : (MACHINE_CAL[machineId] ?? null);

// Build a MACHINE_CAL-shaped object from two user-clicked axle ground-contact points
// (natural image pixels). Anchored at the rear point because SVG tilt rotates around the
// rear tipping point. Span uses the true point distance (not Δx) so that after the tilt
// rotation levels the ground line, the axle span maps exactly to the wheelbase.
function deriveCustomCal(image, calPts) {
  if (!image || !calPts?.rear || !calPts?.front) return null;
  const [rx, ry] = calPts.rear, [fx, fy] = calPts.front;
  const dx = fx - rx, dy = fy - ry;
  if (dx <= 0) return null; // image must face right (front of machine on the right)
  const autoTilt = -Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    img: image.img, imgW: image.imgW, imgH: image.imgH,
    rearAxle: rx / image.imgW,
    frontAxle: (rx + Math.hypot(dx, dy)) / image.imgW,
    groundY: ry / image.imgH,
    tilt: calPts.tiltOverride ?? autoTilt,
    zoomMult: 1, placerZoomMult: 1,
  };
}

// Horizontal (Y, inches) extent of a Custom image after scaling + tilt, so view auto-fit
// keeps the whole machine in frame. Built-ins rely on hand-tuned zoomMult instead, so this
// returns [] for them to leave their framing unchanged.
function getCustomImageYExtent(machineId, cal, geo) {
  if (machineId !== "custom" || !cal || !(geo.wheelbase > 0)) return [];
  const pxPerIn = cal.imgW * Math.abs(cal.frontAxle - cal.rearAxle) / geo.wheelbase;
  if (!(pxPerIn > 0)) return [];
  const t = (cal.tilt ?? 0) * Math.PI / 180;
  const x0 = -cal.rearAxle * cal.imgW / pxPerIn, x1 = (1 - cal.rearAxle) * cal.imgW / pxPerIn;
  const z0 = -(1 - cal.groundY) * cal.imgH / pxPerIn, z1 = cal.groundY * cal.imgH / pxPerIn;
  // Corners relative to the rear tipping point, rotated like SVG rotate(tilt) about it.
  const ys = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]].map(([x, z]) => x * Math.cos(t) + z * Math.sin(t));
  return [-geo.wheelbase + Math.min(...ys), -geo.wheelbase + Math.max(...ys)];
}

// Read an uploaded image and downscale to ≤maxEdge px (PNG keeps transparency) so the
// data URL stays small enough for state and PDF export.
function loadImageAsDataUrl(file, maxEdge = 1200) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        const cvs = document.createElement("canvas"); cvs.width = w; cvs.height = h;
        cvs.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve({ img: cvs.toDataURL("image/png"), imgW: w, imgH: h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Compute SVG x/y/width/height to place a machine image so axles align with tipping points.
// liftHeight > 0: uses the high-lift image for e2500-THL when imgUp exists.
function getMachineImageProps(machineId, to, geo, scaleMult = 1, liftHeight = 0, customCal = null) {
  const cal = resolveMachineCal(machineId, customCal);
  if (!cal) return null;
  const useUp = liftHeight > 0 && !!cal.imgUp;
  const href = assetUrl(useUp ? cal.imgUp : cal.img);
  const srcW = useUp ? cal.imgUpW : cal.imgW;
  const srcH = useUp ? cal.imgUpH : cal.imgH;
  const frontAxle = useUp && cal.frontAxleUp != null ? cal.frontAxleUp : cal.frontAxle;
  const rearAxle  = useUp && cal.rearAxleUp  != null ? cal.rearAxleUp  : cal.rearAxle;
  const groundY   = useUp && cal.groundYUp   != null ? cal.groundYUp   : cal.groundY;
  const [fx] = to(0, 0);
  const [rx] = to(-geo.wheelbase, 0);
  // Front (Y=0) → larger SVG x (right). Rear (Y=-wheelbase) → smaller SVG x (left). fx > rx.
  const svgAxleSpan = fx - rx;
  // frontAxle > rearAxle: front is on the right side of the image (same orientation as SVG)
  const imgAxleSpan = Math.abs(frontAxle - rearAxle) * srcW;
  if (imgAxleSpan <= 0 || svgAxleSpan <= 0) return null;
  const scale = (svgAxleSpan / imgAxleSpan) * scaleMult;
  const imgW = srcW * scale;
  const imgH = srcH * scale;
  // Anchor: rear tipping point (rx in SVG) aligns with rearAxle fraction in image
  const imgX = rx - rearAxle * imgW;
  const [, gy] = to(0, 0); // SVG y of ground level
  const imgY = gy - groundY * imgH;
  return { href, x: imgX, y: imgY, width: imgW, height: imgH };
}

let _id = 0;
const nid = () => ++_id;

// Placeholder geometry — update with real measured values when available.
// Attachment preset data. All Y/Z coordinates are pin-relative:
//   Y positive = toward front of machine from pin
//   Z positive = up from pin
// Translation to machine coords happens in applyAttachmentPreset using geo.pinY/pinZ/width.
// loadWeight is a placeholder — update with rated payload capacity (lbs) when confirmed.
const ATTACHMENT_PRESETS = [
  // ── Standard (full-width) attachments ───────────────────────────────────
  {
    key: "bucket22340", name: "Bucket (22340)",
    attachPinRelY: 10.197, attachPinRelZ: -0.471, attachWeight: 227.69,
    loadPinRelY:   14.736, loadPinRelZ:   1.911,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
  {
    key: "grapple22590", name: "Grapple Bucket (22590)",
    attachPinRelY: 14.886, attachPinRelZ: 4.118,  attachWeight: 306.43,
    loadPinRelY:   24.429, loadPinRelZ:   9.226,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
  {
    key: "forks22586", name: "Forks (22586)",
    attachPinRelY: 11.308, attachPinRelZ: 2.240,  attachWeight: 243.07,
    loadPinRelY:   27.570, loadPinRelZ:   8.318,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
  // ── 30" (narrow) attachments ─────────────────────────────────────────────
  {
    key: "bucket23174", name: "30\" Bucket (23174)",
    attachPinRelY: 9.506,  attachPinRelZ: -0.039, attachWeight: 113.199,
    loadPinRelY:   14.203, loadPinRelZ:   1.855,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
  {
    key: "grapple23176", name: "30\" Grapple Bucket (23176)",
    attachPinRelY: 13.395, attachPinRelZ: 3.124,  attachWeight: 235.48,
    loadPinRelY:   23.646, loadPinRelZ:   7.641,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
  {
    key: "forks23175", name: "30\" Forks (23175)",
    attachPinRelY: 11.479, attachPinRelZ: 1.805,  attachWeight: 181.4,
    loadPinRelY:   26.968, loadPinRelZ:   8.304,  loadWeight: 0, /* TODO: confirm rated capacity */
  },
];

const ATTACH_RE = /bucket|fork|grapple|attachment|load/i;

const DEFAULT_GEO = { wheelbase: 39.25, width: 34.0, armPivotY: 0, armPivotZ: 0, maxPinHeight: 81, hopperPivotY: 0, hopperPivotZ: 0, maxLiftHeight: 0, pinY: null, pinZ: null, swivelPivotY: null };

// Per-machine geometry defaults (NT width for Dingo variants). Source: MACHINE_DEFAULTS.xlsx
// TX1000 armPivotY/Z intentionally 0 — vertical lift machine, pivot not used in kinematics.
// Buggy hopperPivotY/Z: longitudinal (Y) and vertical (Z) position of hopper pivot in machine coords.
const MACHINE_DEFAULTS = {
  tx550:     { wheelbase: 31.5,  width: 33.0,  armPivotY: -42.5,  armPivotZ: 37.8,  maxPinHeight: 65.8, hopperPivotY: 0,    hopperPivotZ: 0, pinY:  8.351, pinZ: 5.049 },
  tx1000:    { wheelbase: 39.25, width: 34.0,  armPivotY: 0,      armPivotZ: 0,     maxPinHeight: 81.0, liftType: "vertical", hopperPivotY: 0, hopperPivotZ: 0, pinY: 8.718, pinZ: 4.937 },
  txe750:    { wheelbase: 44.75, width: 30.5,  armPivotY: -35.25, armPivotZ: 44.5,  maxPinHeight: 81.0, hopperPivotY: 0,    hopperPivotZ: 0, pinY:  8.713, pinZ: 4.902 },
  edingo500: { wheelbase: 28.0,  width: 30.0,  armPivotY: -26.75, armPivotZ: 43.25, maxPinHeight: 81.0, hopperPivotY: 0,    hopperPivotZ: 0, pinY: 12.647, pinZ: 4.975 },
  "2500t":   { wheelbase: 38.0,  width: 35.0,  armPivotY: 0, armPivotZ: 0, maxPinHeight: 0, hopperPivotY: 19,   hopperPivotZ: 22.8  },
  "2500ts":  { wheelbase: 38.0,  width: 35.0,  armPivotY: 0, armPivotZ: 0, maxPinHeight: 0, hopperPivotY: 19,   hopperPivotZ: 28.25, swivelPivotY: 0    },
  e2500:     { wheelbase: 41.0,  width: 31.75, armPivotY: 0, armPivotZ: 0, maxPinHeight: 0, hopperPivotY: 5.75, hopperPivotZ: 18.75 },
  e2500ts:   { wheelbase: 35.0,  width: 31.25, armPivotY: 0, armPivotZ: 0, maxPinHeight: 0, hopperPivotY: 10,   hopperPivotZ: 28,    swivelPivotY: -7   },
  e2500thl:  { wheelbase: 35.0,  width: 31.25, armPivotY: 0, armPivotZ: 0, maxPinHeight: 0, hopperPivotY: 23.8, hopperPivotZ: 42.8, maxLiftHeight: 34.3 },
};

// NT and WT track widths (in.) for Dingo machines with both variants.
// A machine has variants iff its ID exists as a key here.
const VARIANT_WIDTHS = {
  tx550:  { nt: 33.0,  wt: 40.3  },
  tx1000: { nt: 34.0,  wt: 40.0  },
  txe750: { nt: 30.5,  wt: 36.25 },
};

const emptyMachineState = (geoOverride) => ({ comps: [], armAngle: 0, armIds: new Set(), liftHeight: 0, liftIds: new Set(), swivelAngle: 0, trialHistory: [], sensId: null, geo: geoOverride ? { ...geoOverride } : { ...DEFAULT_GEO }, fileName: null, variant: "nt" });

// Combined slider + number input. value/onChange work in display-value space.
// Clamps to [min, max] on blur or Enter; allows free typing of intermediate states.
function MotionInput({ label, min, max, step = 1, value, onChange, unit = "°", buttons }) {
  const [draft, setDraft] = React.useState(null);
  const clamp = v => Math.min(max, Math.max(min, isNaN(v) ? value : v));
  const commit = raw => { setDraft(null); onChange(clamp(parseFloat(raw))); };
  const displayed = draft !== null ? draft : Number(value).toFixed(1);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <label className="text-[#A7A9AC] w-24 shrink-0 text-[10px]">{label}</label>
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(clamp(+e.target.value))} className="flex-1 min-w-0" style={{ accentColor: "#CD2027" }} />
        <div className="flex items-center gap-0.5 shrink-0">
          <input type="number" value={displayed} min={min} max={max} step={step}
            onChange={e => setDraft(e.target.value)}
            onBlur={e => commit(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(e.target.value); }}
            className="w-16 text-right text-white text-[10px] bg-[#1a1a1a] border border-[#3a3a3a] rounded px-1 outline-none"
            style={{ MozAppearance: 'textfield', appearance: 'textfield' }} />
          <span className="text-[#A7A9AC] text-[10px] whitespace-nowrap">{unit}</span>
        </div>
      </div>
      {buttons && <div className="flex gap-1 pl-24">{buttons}</div>}
    </div>
  );
}

// ---- Main App ----
export default function StabilityApp() {
  const [machineId, setMachineId] = useState("tx1000");
  const [machineStates, setMachineStates] = useState({ tx1000: emptyMachineState(MACHINE_DEFAULTS["tx1000"]) });
  const [geo, setGeo] = useState({ ...(MACHINE_DEFAULTS["tx1000"] ?? DEFAULT_GEO) });
  const [comps, setComps] = useState([]);
  const [armAngle, setArmAngle] = useState(0);
  const [armPreset, setArmPreset] = useState(null); // 'reach' | 'height' | null
  const [armIds, setArmIds] = useState(new Set());
  const [sensId, setSensId] = useState(null);
  const [trialHistory, setTrialHistory] = useState([]);
  const [fileName, setFileName] = useState(null);
  const [wInc, setWInc] = useState(25);
  const [heatInc, setHeatInc] = useState(0.5);
  const [centerTab, setCenterTab] = useState("weight");
  const [showLabels, setShowLabels] = useState(true);
  const [liftHeight, setLiftHeight] = useState(0);
  const [liftIds, setLiftIds] = useState(new Set());
  const [swivelAngle, setSwivelAngle] = useState(0);
  const [variant, setVariant] = useState("nt");
  const [variantWarning, setVariantWarning] = useState(false);
  const [tab, setTab] = useState("components");
  const [sideViewExpanded, setSideViewExpanded] = useState(false);
  const [topDownExpanded, setTopDownExpanded] = useState(false);
  const [nc, setNc] = useState({ name: "", x: "", y: "", z: "", weight: "" });
  // Custom machine overlay. Kept outside machineStates: only "custom" reads it, so it
  // naturally survives machine switching without threading through switchMachine.
  const [customImage, setCustomImage] = useState(null);   // { name, img, imgW, imgH }
  const [customCalPts, setCustomCalPts] = useState(null); // { rear, front, tiltOverride }
  const [calModalOpen, setCalModalOpen] = useState(false);
  const [customImgError, setCustomImgError] = useState(null);
  const customCal = useMemo(() => deriveCustomCal(customImage, customCalPts), [customImage, customCalPts]);
  const imgFr = useRef(null);
  const trial = trialHistory[trialHistory.length - 1] ?? null;
  const fr = useRef(null);
  const prevMachineId = useRef(machineId);
  const sideViewRef = useRef(null);
  const mach = MACHINES.find(m => m.id === machineId);

  useEffect(() => {
    if (!sideViewExpanded && !topDownExpanded) return;
    const onKey = e => { if (e.key === 'Escape') { setSideViewExpanded(false); setTopDownExpanded(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sideViewExpanded, topDownExpanded]);

  useEffect(() => {
    if (!sensId) return;
    const comp = comps.find(c => c.id === sensId);
    if (comp?.weight) setWInc(Math.max(1, Math.round(0.01 * comp.weight)));
  }, [sensId]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchMachine = useCallback((newId) => {
    const saved = { comps, armAngle, armIds, liftHeight, liftIds, swivelAngle, trialHistory, sensId, geo, fileName, variant };
    setMachineStates(s => ({ ...s, [prevMachineId.current]: saved }));
    prevMachineId.current = newId;
    setMachineId(newId);
    const next = machineStates[newId] ?? emptyMachineState(MACHINE_DEFAULTS[newId]);
    setComps(next.comps);
    setArmAngle(next.armAngle);
    setArmPreset(null);
    setArmIds(next.armIds);
    setLiftHeight(next.liftHeight ?? 0);
    setLiftIds(next.liftIds ?? new Set());
    setSwivelAngle(next.swivelAngle ?? 0);
    setTrialHistory(next.trialHistory);
    setSensId(next.sensId);
    const def = MACHINE_DEFAULTS[newId];
    setGeo(def ? { ...next.geo, armPivotY: def.armPivotY, armPivotZ: def.armPivotZ, hopperPivotY: def.hopperPivotY, hopperPivotZ: def.hopperPivotZ, maxLiftHeight: def.maxLiftHeight ?? 0, pinY: def.pinY ?? null, pinZ: def.pinZ ?? null, swivelPivotY: def.swivelPivotY ?? null } : next.geo);
    setFileName(next.fileName);
    setVariant(next.variant ?? "nt");
    setVariantWarning(false);
    if (fr.current) fr.current.value = "";
  }, [comps, armAngle, armIds, liftHeight, liftIds, trialHistory, sensId, geo, fileName, variant, machineStates]);

  const handleVariantChange = useCallback((newVariant) => {
    if (newVariant === variant) return;
    setVariant(newVariant);
    setGeo(g => ({ ...g, width: VARIANT_WIDTHS[machineId][newVariant] }));
    if (comps.length > 0) setVariantWarning(true);
  }, [variant, machineId, comps]);

  const handleFile = useCallback(e => {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = ev => {
      try {
        const rows = parseUploadedFile(ev.target.result);
        const p = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i]; if (!r?.[0]) continue;
          const [x, y, z, weight] = [r[1], r[2], r[3], r[4]].map(parseNumericCell);
          p.push({ id: nid(), name: String(r[0]), x, y, z, weight, enabled: true, _restY: y, _restZ: z });
        }
        if (p.length === 0 || !p.some(c => c.name && c.weight !== 0)) {
          alert("CSV format error. Expected columns: Name, X, Y, Z, Weight (lbs). No valid data found — check your file.");
          return;
        }
        const ARM_PATTERN = /arm|bucket|attachment|load|hopper|tub/i;
        const autoArmIds = new Set(p.filter(c => ARM_PATTERN.test(c.name)).map(c => c.id));
        setComps(p); if (p.length) setSensId(p[0].id);
        setArmIds(autoArmIds);
        setFileName(f.name);
        setVariantWarning(false);
      } catch (err) { alert("Parse error: " + err.message); }
    };
    rd.readAsArrayBuffer(f);
  }, [machineId]);

  const clearFile = useCallback(() => {
    setComps([]); setSensId(null); setTrialHistory([]); setFileName(null);
    if (fr.current) fr.current.value = "";
  }, []);

  const handleCustomImage = useCallback(async e => {
    const f = e.target.files?.[0]; if (!f) return;
    if (imgFr.current) imgFr.current.value = ""; // allow re-selecting the same file
    if (!/^image\/(png|jpeg)$/.test(f.type)) { setCustomImgError("Use a PNG or JPG image."); return; }
    try {
      const loaded = await loadImageAsDataUrl(f);
      setCustomImage({ name: f.name, ...loaded });
      setCustomCalPts(null);
      setCustomImgError(null);
      setCalModalOpen(true);
    } catch { setCustomImgError("Could not read that image."); }
  }, []);

  const clearCustomImage = useCallback(() => {
    setCustomImage(null); setCustomCalPts(null); setCustomImgError(null);
  }, []);

  const addC = useCallback(() => {
    if (!nc.name) return;
    const c = { id: nid(), name: nc.name, x: +nc.x || 0, y: +nc.y || 0, z: +nc.z || 0, weight: +nc.weight || 0, enabled: true };
    c._restY = c.y; c._restZ = c.z;
    const ARM_PATTERN = /arm|bucket|attachment|load|hopper|tub/i;
    if (ARM_PATTERN.test(c.name)) setArmIds(p => new Set([...p, c.id]));
    setComps(p => [...p, c]); setNc({ name: "", x: "", y: "", z: "", weight: "" });
  }, [nc]);

  const togC = useCallback(id => setComps(p => p.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c)), []);
  const remC = useCallback(id => { setComps(p => p.filter(c => c.id !== id)); setArmIds(p => { const n = new Set(p); n.delete(id); return n; }); setLiftIds(p => { const n = new Set(p); n.delete(id); return n; }); }, []);
  const togArm = useCallback(id => setArmIds(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const togLift = useCallback(id => setLiftIds(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);

  const applyAttachmentPreset = useCallback((key) => {
    const preset = ATTACHMENT_PRESETS.find(p => p.key === key);
    if (!preset) return;

    // Translate pin-relative coords → machine coords.
    // pinY/pinZ may be null on Custom machine — fall back to 0 so the function
    // still runs and positions the attachment near the machine front.
    const pinY = geo.pinY ?? 0;
    const pinZ = geo.pinZ ?? 0;
    const cx   = geo.width / 2;

    // "Y to the right" in the attachment spreadsheet = rearward = positive machine Y.
    // Both pin and local offsets add together; Z sign is preserved (localZ is negative when below pin).
    const attachY = pinY + preset.attachPinRelY;
    const attachZ = pinZ + preset.attachPinRelZ;
    const loadY   = pinY + preset.loadPinRelY;
    const loadZ   = pinZ + preset.loadPinRelZ;

    const attachComp = {
      id: nid(), name: preset.name,
      x: cx, y: attachY, z: attachZ,
      weight: preset.attachWeight, enabled: true,
      _restY: attachY, _restZ: attachZ,
    };
    const loadComp = {
      id: nid(), name: preset.name + " Load",
      x: cx, y: loadY, z: loadZ,
      weight: preset.loadWeight, enabled: true,
      _restY: loadY, _restZ: loadZ,
    };

    const removeIds = comps.filter(c => ATTACH_RE.test(c.name)).map(c => c.id);
    setComps(p => [...p.filter(c => !removeIds.includes(c.id)), attachComp, loadComp]);
    setArmIds(p => {
      const n = new Set([...p].filter(id => !removeIds.includes(id)));
      n.add(attachComp.id);
      n.add(loadComp.id);
      return n;
    });
  }, [comps, geo.pinY, geo.pinZ, geo.width]);

  const updC = useCallback((id, f, v) => setComps(p => p.map(c => {
    if (c.id !== id) return c;
    const u = { ...c, [f]: f === "name" ? v : +v || 0 };
    if (f === "y") u._restY = u.y; if (f === "z") u._restZ = u.z; return u;
  })), []);

  const svgHeight = useMemo(() => {
    const pts = comps.filter(c => c.enabled).map(c => getEffPos(c, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle));
    if (pts.length === 0) return 300;
    const allY = [0, -geo.wheelbase, ...pts.map(p => p.y)];
    const ySpan = Math.max(...allY) - Math.min(...allY);
    const zMax = Math.max(...pts.map(p => p.z), 5);
    const ratio = zMax / Math.max(ySpan, 1);
    return Math.max(180, Math.min(420, Math.round(400 * ratio) + 40));
  }, [comps, geo, armAngle, armIds, liftHeight, liftIds]);

  const ov = useMemo(() => trial && sensId ? { [sensId]: { y: trial.y, z: trial.z } } : null, [trial, sensId]);
  const result = useMemo(() => computeStability(comps, geo, armAngle, armIds, ov, liftHeight, liftIds, swivelAngle), [comps, geo, armAngle, armIds, ov, liftHeight, liftIds, swivelAngle]);
  const baseRes = useMemo(() => computeStability(comps, geo, armAngle, armIds, undefined, liftHeight, liftIds, swivelAngle), [comps, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle]);
  const roc = useMemo(() => computeROC(comps, geo, armIds, mach?.k), [comps, geo, armIds, mach]);
  const fwdW = useMemo(() => sensId ? computeWeightSens(comps, geo, armAngle, armIds, sensId, 21, wInc, "fwd", liftHeight, liftIds, swivelAngle) : null, [comps, geo, armAngle, armIds, sensId, wInc, liftHeight, liftIds, swivelAngle]);
  const rearW = useMemo(() => sensId ? computeWeightSens(comps, geo, armAngle, armIds, sensId, 21, wInc, "rear", liftHeight, liftIds, swivelAngle) : null, [comps, geo, armAngle, armIds, sensId, wInc, liftHeight, liftIds, swivelAngle]);
  const heatmap = useMemo(() => centerTab === "heatmap" && sensId ? computeHeatmap(comps, geo, armAngle, armIds, sensId, 21, heatInc, liftHeight, liftIds, swivelAngle) : null, [centerTab, comps, geo, armAngle, armIds, sensId, heatInc, liftHeight, liftIds, swivelAngle]);
  const sensRanking = useMemo(() => {
    if (!result) return [];
    const dp = 0.5;
    return comps
      .filter(c => c.enabled && c.weight > 0)
      .map(c => {
        const p = getEffPos(c, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle);
        const base = result.fwdTip;
        const rY = computeStability(comps, geo, armAngle, armIds, { [c.id]: { y: p.y + dp, z: p.z } }, liftHeight, liftIds, swivelAngle);
        const rZ = computeStability(comps, geo, armAngle, armIds, { [c.id]: { y: p.y, z: p.z + dp } }, liftHeight, liftIds, swivelAngle);
        const dY = rY ? (rY.fwdTip - base) / dp : 0;
        const dZ = rZ ? (rZ.fwdTip - base) / dp : 0;
        return { id: c.id, name: c.name, dY, dZ, worst: Math.max(Math.abs(dY), Math.abs(dZ)) };
      })
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 5);
  }, [comps, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle, result]);

  const rearRanking = useMemo(() => {
    if (!result) return [];
    const dp = 0.5;
    return comps
      .filter(c => c.enabled && c.weight > 0)
      .map(c => {
        const p = getEffPos(c, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle);
        const base = result.rearTip;
        const rY = computeStability(comps, geo, armAngle, armIds, { [c.id]: { y: p.y + dp, z: p.z } }, liftHeight, liftIds, swivelAngle);
        const rZ = computeStability(comps, geo, armAngle, armIds, { [c.id]: { y: p.y, z: p.z + dp } }, liftHeight, liftIds, swivelAngle);
        const dY = rY ? (rY.rearTip - base) / dp : 0;
        const dZ = rZ ? (rZ.rearTip - base) / dp : 0;
        return { id: c.id, name: c.name, dY, dZ, worst: Math.max(Math.abs(dY), Math.abs(dZ)) };
      })
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 5);
  }, [comps, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle, result]);

  const pushTrial = useCallback(pos => setTrialHistory(h => [...h.slice(-9), pos]), []);
  const undoTrial = useCallback(() => setTrialHistory(h => h.slice(0, -1)), []);
  const resetTrial = useCallback(() => setTrialHistory([]), []);

  // Arm angle display helpers (radial-arc machines only).
  // Internal armAngle state is relative (0 = rest); displayed value adds restAngle offset.
  // restAngle = absolute angle of pivot→pin vector from horizontal at the lowered (rest) position.
  const armRestAngle = useMemo(() => {
    const { pinY, pinZ, armPivotY, armPivotZ } = geo;
    if (pinY == null || pinZ == null) return 0;
    return Math.atan2(pinZ - armPivotZ, pinY - armPivotY) * (180 / Math.PI);
  }, [geo.pinY, geo.pinZ, geo.armPivotY, geo.armPivotZ]);

  const armLength = useMemo(() => {
    const { pinY, pinZ, armPivotY, armPivotZ } = geo;
    if (pinY == null || pinZ == null) return Math.sqrt(armPivotY ** 2 + (geo.maxPinHeight - armPivotZ) ** 2);
    return Math.sqrt((pinY - armPivotY) ** 2 + (pinZ - armPivotZ) ** 2);
  }, [geo.pinY, geo.pinZ, geo.armPivotY, geo.armPivotZ, geo.maxPinHeight]);

  // State angle where display angle = 0° (pivot→pin vector horizontal = max reach).
  const maxReachAngle = useMemo(() => Math.max(0, -armRestAngle), [armRestAngle]);

  // asin gives degrees above horizontal; subtract armRestAngle to convert to rest-relative state space.
  const armSliderMax = geo.maxPinHeight > 0
    ? Math.asin(Math.min(1, (geo.maxPinHeight - geo.armPivotZ) / Math.max(1, armLength))) * (180 / Math.PI) - armRestAngle
    : 90;

  const exportPDF = useCallback(async () => {
    if (!result) { alert("No results to export. Add components first."); return; }

    // Portrait letter
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const PW = pdf.internal.pageSize.getWidth();  // 612
    const PH = pdf.internal.pageSize.getHeight(); // 792
    const LM = 18, RM = 18; // left/right margin
    const CW = PW - LM - RM; // content width = 576

    // ── Helper: fetch a URL and return a base64 data URL ──
    const toDataURL = async (url) => {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.readAsDataURL(blob); });
    };

    // ── 1. HEADER ──
    const HDR_H = 44;
    pdf.setFillColor(205, 32, 39);
    pdf.rect(0, 0, PW, HDR_H, "F");

    // Logo — preserve aspect ratio
    try {
      const logoDataURL = await toDataURL(assetUrl("/bullhorn.png"));
      const logoImg = new Image();
      await new Promise(res => { logoImg.onload = res; logoImg.src = logoDataURL; });
      const logoNatW = logoImg.naturalWidth || 120;
      const logoNatH = logoImg.naturalHeight || 60;
      const logoH = 28;
      const logoW = logoH * (logoNatW / logoNatH);
      const cvs = document.createElement("canvas"); cvs.width = logoNatW; cvs.height = logoNatH;
      const ctx = cvs.getContext("2d");
      ctx.filter = "brightness(0) invert(1)"; ctx.drawImage(logoImg, 0, 0, logoNatW, logoNatH);
      pdf.addImage(cvs.toDataURL("image/png"), "PNG", LM, (HDR_H - logoH) / 2, logoW, logoH);
    } catch (_) {}

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(13); pdf.setFont("helvetica", "bold");
    pdf.text("Siteworks Stability Analysis", PW / 2, 18, { align: "center" });
    pdf.setFontSize(9); pdf.setFont("helvetica", "normal");
    pdf.text(`${mach?.name ?? machineId}  ·  ${mach?.standard ?? ""}${mach?.k ? `  (k=${mach.k})` : ""}`, PW / 2, 32, { align: "center" });
    pdf.text(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), PW - RM, 18, { align: "right" });

    // ── 2. DARK BACKGROUND ──
    pdf.setFillColor(26, 26, 26);
    pdf.rect(0, HDR_H, PW, PH - HDR_H, "F");

    let curY = HDR_H + 8;

    // ── 3. SIDE VIEW IMAGE — preserve aspect ratio, centered ──
    // SVG viewBox is 400×360. Fit available vertical space (conservative: reserves room for all sections below).
    // BELOW_H = trial banner(16) + geo(41) + results bar(16) + results rows w/ROC(130) + top5+gaps(100) + footer(30) + misc padding(32)
    const BELOW_H = 345;
    const SVG_VB_W = 400, SVG_VB_H = 360;
    const IMG_MAX_W = CW, IMG_MAX_H = PH - HDR_H - 8 - BELOW_H;
    const imgScale = Math.min(IMG_MAX_W / SVG_VB_W, IMG_MAX_H / SVG_VB_H);
    const IMG_W = SVG_VB_W * imgScale;
    const IMG_H = SVG_VB_H * imgScale;
    const IMG_X = LM + (CW - IMG_W) / 2; // center horizontally
    let truncated = false;
    const trialComp = trial && sensId ? comps.find(c => c.id === sensId) : null;
    const trialBase = trial && trialComp ? getEffPos(trialComp, geo, armAngle, armIds) : null;

    if (sideViewRef.current) {
      try {
        const svgEl = sideViewRef.current;
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

        // Inline machine image href as base64 so it renders in offscreen canvas
        // Custom images are already data URLs and render in the offscreen canvas as-is.
        const machCal = resolveMachineCal(machineId, customCal);
        if (machCal?.img && !machCal.img.startsWith("data:")) {
          try {
            const b64 = await toDataURL(assetUrl(liftHeight > 0 && machCal.imgUp ? machCal.imgUp : machCal.img));
            clone.querySelectorAll("image").forEach(el => {
              if (el.getAttribute("href")?.includes("machines")) el.setAttribute("href", b64);
            });
          } catch (_) {}
        }

        // Filter to top 15 components by weight if needed
        const enabledComps = [...comps].filter(c => c.enabled).sort((a, b) => b.weight - a.weight);
        if (enabledComps.length > 15) {
          truncated = true;
          const keepIds = new Set(enabledComps.slice(0, 15).map(c => String(c.id)));
          clone.querySelectorAll("[data-comp-id]").forEach(el => {
            if (!keepIds.has(el.getAttribute("data-comp-id"))) el.remove();
          });
        }

        const svgStr = new XMLSerializer().serializeToString(clone);
        const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
        const svgUrl = URL.createObjectURL(svgBlob);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = svgUrl; });
        // Canvas matches SVG viewBox aspect ratio exactly
        const cvs = document.createElement("canvas"); cvs.width = SVG_VB_W * 2; cvs.height = SVG_VB_H * 2;
        const ctx = cvs.getContext("2d");
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, cvs.width, cvs.height);
        ctx.drawImage(img, 0, 0, cvs.width, cvs.height);

        // Overlay trial dot on canvas if trial active
        if (trial && trialComp && trialBase) {
          // Reconstruct the same to() transform used in SideView
          const pad = 15, w = SVG_VB_W, h = SVG_VB_H;
          const pts2 = comps.filter(c => c.enabled).map(c => getEffPos(c, geo, armAngle, armIds, liftHeight, liftIds, swivelAngle));
          const allY2 = [0, -geo.wheelbase, ...pts2.map(p => p.y)];
          const allZ2 = [0, ...pts2.map(p => p.z)];
          const yMin2 = Math.min(...allY2), yMax2 = Math.max(...allY2);
          const zMax2 = pts2.length ? Math.max(...allZ2, 5) : (geo.maxPinHeight / 2 || 60);
          const scH2 = (w - 2 * pad) / Math.max(yMax2 - yMin2, 1);
          const scV2 = (h - 2 * pad) / Math.max(zMax2, 1);
          const sc2 = Math.min(scH2, scV2);
          const spanW2 = (yMax2 - yMin2) * sc2;
          const oX2 = (w - spanW2) / 2 - yMin2 * sc2;
          const spanH2 = zMax2 * sc2;
          const oY2 = h - (h - spanH2) / 2 - 20;
          const toSVG = (y, z) => [oX2 + y * sc2, oY2 - z * sc2];
          // Scale canvas coords = SVG coords * 2
          const [tx, ty2] = toSVG(trial.y, trial.z).map(v => v * 2);
          const [ax, ay] = toSVG(trialBase.y, trialBase.z).map(v => v * 2);
          // Draw dashed line from actual to trial
          ctx.save();
          ctx.strokeStyle = "#FCB830"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(tx, ty2); ctx.stroke();
          ctx.setLineDash([]);
          // Trial dot
          ctx.fillStyle = "#FCB830"; ctx.beginPath(); ctx.arc(tx, ty2, 8, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
          // Distance label
          const dY = (trial.y - trialBase.y).toFixed(1);
          const dZ = (trial.z - trialBase.z).toFixed(1);
          const lbl = `DY=${parseFloat(dY) >= 0 ? "+" : ""}${dY}" DZ=${parseFloat(dZ) >= 0 ? "+" : ""}${dZ}"`;
          ctx.font = "bold 18px Arial"; ctx.fillStyle = "#FCB830";
          ctx.fillText(lbl, tx + 12, ty2 - 8);
          ctx.restore();
        }

        URL.revokeObjectURL(svgUrl);
        pdf.addImage(cvs.toDataURL("image/png"), "PNG", IMG_X, curY, IMG_W, IMG_H);
      } catch (e) {
        console.warn("SideView capture failed:", e);
        pdf.setDrawColor(75, 79, 84); pdf.rect(IMG_X, curY, IMG_W, IMG_H);
        pdf.setTextColor(128, 130, 133); pdf.setFontSize(9);
        pdf.text("Side View unavailable", PW / 2, curY + IMG_H / 2, { align: "center" });
      }
      pdf.setDrawColor(75, 79, 84); pdf.setLineWidth(0.5);
      pdf.rect(IMG_X, curY, IMG_W, IMG_H);
    }
    curY += IMG_H + 6;

    // Trial active banner (below image)
    if (trial && trialComp && trialBase) {
      pdf.setFillColor(60, 45, 0);
      pdf.rect(LM, curY, CW, 14, "F");
      pdf.setTextColor(252, 184, 48); pdf.setFontSize(8); pdf.setFont("helvetica", "bold");
      const dY = (trial.y - trialBase.y).toFixed(1);
      const dZ = (trial.z - trialBase.z).toFixed(1);
      const dYStr = `DY=${parseFloat(dY) >= 0 ? "+" : ""}${dY}"`;
      const dZStr = `DZ=${parseFloat(dZ) >= 0 ? "+" : ""}${dZ}"`;
      pdf.text(`TRIAL PLACEMENT: ${trialComp.name}  ${dYStr}  ${dZStr}`, LM + 4, curY + 10);
      curY += 16;
    }

    // ── 4. GEOMETRY (horizontal single row) ──
    const GEO_H = 28;
    pdf.setFillColor(43, 46, 49);
    pdf.rect(LM, curY, CW, 13, "F");
    pdf.setTextColor(205, 32, 39); pdf.setFontSize(8); pdf.setFont("helvetica", "bold");
    pdf.text("GEOMETRY", LM + 4, curY + 9);
    curY += 13;

    const geoFields = [
      ["Wheelbase", geo.wheelbase.toFixed(1), "in."],
      ["Width", geo.width.toFixed(1), "in."],
      ...(mach?.hasArm ? [
        ["Arm Pivot Y", geo.armPivotY.toFixed(2), "in."],
        ["Arm Pivot Z", geo.armPivotZ.toFixed(2), "in."],
        ["Max Pin Ht", geo.maxPinHeight.toFixed(1), "in."],
      ] : []),
    ];
    const gColW = CW / geoFields.length;
    geoFields.forEach(([lbl, val, unit], i) => {
      const gx = LM + i * gColW;
      pdf.setTextColor(167, 169, 172); pdf.setFontSize(8); pdf.setFont("helvetica", "normal");
      pdf.text(lbl, gx + gColW / 2, curY + 6, { align: "center" });
      pdf.setTextColor(255, 255, 255); pdf.setFontSize(9.5); pdf.setFont("helvetica", "bold");
      pdf.text(`${val} ${unit}`, gx + gColW / 2, curY + 15, { align: "center" });
      if (i > 0) { pdf.setDrawColor(60, 64, 68); pdf.setLineWidth(0.5); pdf.line(gx, curY, gx, curY + GEO_H); }
    });
    curY += GEO_H;

    // ── 5. RESULTS — full width, vertical layout ──
    const rowH = 13;
    // "RESULTS" title bar
    pdf.setFillColor(205, 32, 39);
    pdf.rect(LM, curY, CW, 14, "F");
    pdf.setTextColor(255, 255, 255); pdf.setFontSize(10); pdf.setFont("helvetica", "bold");
    pdf.text("RESULTS", PW / 2, curY + 11, { align: "center" });
    curY += 16;

    // Two-column results layout: left col and right col
    const HALF = Math.floor(CW / 2) - 4;
    const COL2_X = LM + HALF + 8;
    let leftY = curY;
    let rightY = curY;

    const sectionHdr = (label, x, w, yRef) => {
      pdf.setFillColor(43, 46, 49); pdf.rect(x, yRef, w, rowH, "F");
      pdf.setTextColor(205, 32, 39); pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold");
      pdf.text(label.toUpperCase(), x + 3, yRef + 9);
      return yRef + rowH;
    };

    const dataRow = (label, value, unit = "", highlight = false, x = LM, w = HALF, yRef = leftY) => {
      pdf.setFontSize(8.5); pdf.setFont("helvetica", "normal");
      pdf.setTextColor(167, 169, 172); pdf.text(label, x + 3, yRef + 9);
      pdf.setTextColor(highlight ? 252 : 255, highlight ? 184 : 255, highlight ? 48 : 255);
      pdf.setFont("helvetica", "bold");
      pdf.text(value, x + w - 22, yRef + 9, { align: "right" });
      pdf.setFont("helvetica", "normal"); pdf.setTextColor(128, 130, 133);
      pdf.text(unit, x + w - 19, yRef + 9);
      pdf.setDrawColor(43, 46, 49); pdf.setLineWidth(0.3);
      pdf.line(x, yRef + rowH, x + w, yRef + rowH);
      return yRef + rowH;
    };

    // Draw small filled triangle using polygon path (avoids Unicode rendering issues)
    const drawTriangle = (x, y, up, color) => {
      pdf.setFillColor(color[0], color[1], color[2]);
      if (up) {
        pdf.triangle(x, y + 3, x + 4, y - 3, x - 4, y - 3, "F");
      } else {
        pdf.triangle(x, y - 3, x + 4, y + 3, x - 4, y + 3, "F");
      }
    };

    const tipRow = (label, val, baseVal, x = LM, w = HALF, yRef = leftY) => {
      const delta = baseVal != null ? val - baseVal : null;
      pdf.setFontSize(8.5); pdf.setFont("helvetica", "normal");
      pdf.setTextColor(167, 169, 172); pdf.text(label, x + 3, yRef + 9);
      const low = val < 15;
      pdf.setTextColor(low ? 205 : 255, low ? 32 : 255, low ? 39 : 255);
      pdf.setFont("helvetica", "bold");
      pdf.text(val.toFixed(1) + "°", x + w - 28, yRef + 9, { align: "right" });
      if (delta !== null) {
        const up = delta >= 0;
        const col = up ? [134, 239, 172] : [205, 32, 39];
        drawTriangle(x + w - 20, yRef + 7, up, col);
        pdf.setTextColor(col[0], col[1], col[2]);
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(8);
        pdf.text(Math.abs(delta).toFixed(1) + "°", x + w - 4, yRef + 9, { align: "right" });
      }
      pdf.setDrawColor(43, 46, 49); pdf.setLineWidth(0.3);
      pdf.line(x, yRef + rowH, x + w, yRef + rowH);
      return yRef + rowH;
    };

    // Left column: CG + Tipping Angles
    leftY = sectionHdr("Center of Gravity", LM, HALF, leftY);
    leftY = dataRow("CG, X", result.cgX.toFixed(1), "in.", false, LM, HALF, leftY);
    leftY = dataRow("CG, Y", result.cgY.toFixed(1), "in.", !!(trial && trialComp), LM, HALF, leftY);
    leftY = dataRow("CG, Z", result.cgZ.toFixed(1), "in.", !!(trial && trialComp), LM, HALF, leftY);
    leftY = dataRow("Total Weight", result.totalW.toFixed(1), "lbs", false, LM, HALF, leftY);
    leftY = sectionHdr("Tipping Angles", LM, HALF, leftY);
    leftY = tipRow("Forward", result.fwdTip, trial ? baseRes?.fwdTip : null, LM, HALF, leftY);
    leftY = tipRow("Rear", result.rearTip, trial ? baseRes?.rearTip : null, LM, HALF, leftY);
    leftY = tipRow("Left", result.leftTip, null, LM, HALF, leftY);
    leftY = tipRow("Right", result.rightTip, null, LM, HALF, leftY);

    // Right column: Weight Distribution + Corner Weights + ROC
    rightY = sectionHdr("Weight Distribution", COL2_X, HALF, rightY);
    rightY = dataRow("% Front", (result.pctFront * 100).toFixed(1), "%", false, COL2_X, HALF, rightY);
    rightY = dataRow("% Rear", ((1 - result.pctFront) * 100).toFixed(1), "%", false, COL2_X, HALF, rightY);
    rightY = sectionHdr("Corner Weights", COL2_X, HALF, rightY);
    rightY = dataRow("Front Left", result.fl.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
    rightY = dataRow("Front Right", result.fr.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
    rightY = dataRow("Rear Left", result.rl.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
    rightY = dataRow("Rear Right", result.rr.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
    if (roc) {
      rightY = sectionHdr("ROC", COL2_X, HALF, rightY);
      rightY = dataRow("k factor", mach?.k?.toFixed(2) ?? "-", "", false, COL2_X, HALF, rightY);
      rightY = dataRow("Tipping Load", roc.mTip.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
      rightY = dataRow("ROC", roc.roc.toFixed(1), "lbs", false, COL2_X, HALF, rightY);
    }

    curY = Math.max(leftY, rightY) + 8;

    // ── 6. TOP 5 TABLES — side by side, full width ──
    if (sensRanking.length > 0 || rearRanking.length > 0) {
      const T5_COL_W = Math.floor(CW / 2) - 4;
      const T5_COL2_X = LM + T5_COL_W + 8;

      const drawTop5 = (ranking, title, color, tx, tw, startY) => {
        let ty = startY;
        pdf.setFillColor(43, 46, 49); pdf.rect(tx, ty, tw, rowH, "F");
        pdf.setTextColor(color[0], color[1], color[2]); pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold");
        pdf.text(title, tx + 3, ty + 9); ty += rowH;
        pdf.setTextColor(75, 79, 84); pdf.setFontSize(7); pdf.setFont("helvetica", "normal");
        pdf.text("#", tx + 3, ty + 8);
        pdf.text("Component", tx + 13, ty + 8);
        pdf.text("d/dY", tx + tw - 26, ty + 8, { align: "right" });
        pdf.text("d/dZ", tx + tw - 4, ty + 8, { align: "right" });
        ty += 10;
        ranking.forEach((s, i) => {
          pdf.setTextColor(color[0], color[1], color[2]); pdf.setFontSize(7.5); pdf.setFont("helvetica", "bold");
          pdf.text(String(i + 1), tx + 3, ty + 9);
          pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "normal");
          pdf.text(s.name.slice(0, 20), tx + 13, ty + 9);
          pdf.setTextColor(167, 169, 172);
          pdf.text(`${s.dY >= 0 ? "+" : ""}${s.dY.toFixed(2)}`, tx + tw - 26, ty + 9, { align: "right" });
          pdf.text(`${s.dZ >= 0 ? "+" : ""}${s.dZ.toFixed(2)}`, tx + tw - 4, ty + 9, { align: "right" });
          pdf.setDrawColor(43, 46, 49); pdf.setLineWidth(0.3);
          pdf.line(tx, ty + rowH - 1, tx + tw, ty + rowH - 1);
          ty += rowH;
        });
        return ty;
      };

      const fwdEnd = sensRanking.length > 0 ? drawTop5(sensRanking, "FWD TIP SENSITIVITY - TOP 5", [252, 184, 48], LM, T5_COL_W, curY) : curY;
      const rearEnd = rearRanking.length > 0 ? drawTop5(rearRanking, "REAR TIP SENSITIVITY - TOP 5", [74, 144, 217], T5_COL2_X, T5_COL_W, curY) : curY;
      curY = Math.max(fwdEnd, rearEnd) + 4;
    }

    // ── 7. FOOTER ──
    pdf.setFillColor(0, 0, 0); pdf.rect(0, PH - 30, PW, 30, "F");
    pdf.setTextColor(128, 130, 133); pdf.setFontSize(7.5); pdf.setFont("helvetica", "normal");
    let footerLeft = "Toro Company Confidential";
    if (truncated) footerLeft += "  |  Showing top 15 components by weight";
    pdf.text(footerLeft, LM, PH - 10);
    pdf.text(`Generated: ${new Date().toLocaleString("en-US")}`, PW - RM, PH - 10, { align: "right" });

    const safeName = (mach?.name ?? machineId).replace(/\s+/g, "_");
    pdf.save(`Toro_Stability_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`);
  }, [result, baseRes, trial, mach, machineId, roc, comps, geo, armAngle, armIds, sensId, sensRanking, rearRanking, sideViewRef, liftHeight, customCal]);

  const pf = (v, d) => { if (!result) return { pass: null, threshold: null }; if (mach?.standard === "ANSI B56.8") { const t = d === "lat" ? 18 : 14; return { pass: v >= t, threshold: t }; } return { pass: null, threshold: null }; };

  const gf = (l, k, u = "in.") => (
    <div className="flex items-center gap-1 text-xs">
      <label className="text-[#A7A9AC] w-24 shrink-0 text-[10px]">{l}</label>
      <input type="number" step="1" value={geo[k]}
        onChange={e => setGeo(g => ({ ...g, [k]: +e.target.value || 0 }))}
        onKeyDown={e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const up = e.key === "ArrowUp"; setGeo(g => { const v = g[k]; const snapped = up ? (Number.isInteger(v) ? v + 1 : Math.ceil(v)) : (Number.isInteger(v) ? v - 1 : Math.floor(v)); return { ...g, [k]: snapped }; }); } }}
        className="w-16 bg-[#2B2E31] border border-[#3A3D41] rounded px-1 py-0.5 text-white text-right text-[10px]" style={{ borderColor: "#4B4F54" }} />
      <span className="text-[#A7A9AC] text-[9px]">{u}</span>
    </div>
  );

  const hasSil = machineId.startsWith("tx") || machineId === "edingo500";

  return (
    <>
    <div className="min-h-screen bg-[#0D0D0D] text-white" style={{ fontFamily: "'Verdana','Arial Narrow',Arial,sans-serif" }}>
      <div className="bg-black border-b px-4 py-1.5 flex items-center gap-3" style={{ borderColor: "#CD2027" }}>
        <img src={assetUrl("/bullhorn.png")} alt="Toro" className="h-7 opacity-95" style={{ filter: "brightness(0) invert(1)" }} />
        <div className="w-px h-5 bg-[#3A3D41] mx-1" />
        <h1 className="text-sm font-bold tracking-wider uppercase text-white">SWS Stability Analysis Tool</h1>
        <span className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ backgroundColor: "#CD2027", color: "#fff" }}>v5.6</span>
        <div className="ml-auto flex items-center gap-2">
          <select value={machineId} onChange={e => switchMachine(e.target.value)} className="bg-[#2B2E31] border border-[#4B4F54] text-xs rounded px-2 py-1 text-white">
            {MACHINES.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <span className="text-[10px] px-2 py-0.5 rounded bg-[#2B2E31] text-[#A7A9AC]">{mach?.standard}{mach?.k ? ` (k=${mach.k})` : ""}</span>
        </div>
      </div>

      <div className="flex" style={{ height: "calc(100vh - 40px)" }}>
        {/* LEFT */}
        <div className="w-68 bg-[#1A1A1A] border-r border-[#2B2E31] flex flex-col overflow-hidden shrink-0" style={{ width: 272 }}>
          <div className="p-2.5 border-b border-[#2B2E31] space-y-1.5">
            <h2 className="text-[9px] font-bold uppercase text-[#A7A9AC] mb-1">Geometry</h2>
            {VARIANT_WIDTHS[machineId] && (
              <div className="flex items-center gap-1">
                <span className="text-[#A7A9AC] text-[10px] w-24 shrink-0">Track Variant</span>
                <div className="relative flex rounded-full overflow-hidden border border-[#3A3D41]" style={{ backgroundColor: "#2B2E31" }}>
                  <div className="absolute top-0 bottom-0 w-1/2 rounded-full transition-transform duration-200"
                    style={{ backgroundColor: "#CD2027", transform: variant === "wt" ? "translateX(100%)" : "translateX(0%)" }} />
                  {["nt", "wt"].map(v => (
                    <button key={v} onClick={() => handleVariantChange(v)}
                      className="relative z-10 text-[9px] uppercase tracking-wider px-3 py-1 transition-colors duration-200"
                      style={{ color: variant === v ? "#fff" : "#808285", fontWeight: variant === v ? "bold" : "normal", minWidth: 40 }}>
                      {v.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {variantWarning && (
              <div className="flex items-center justify-between rounded px-2 py-1 text-[9px]" style={{ backgroundColor: "rgba(252,184,48,0.12)", border: "1px solid rgba(252,184,48,0.3)" }}>
                <span style={{ color: "#FCB830" }}>Variant changed. Component weights may not reflect this variant.</span>
                <button onClick={() => setVariantWarning(false)} style={{ color: "#FCB830" }} className="ml-2 font-bold text-sm leading-none">×</button>
              </div>
            )}
            {gf("Wheelbase", "wheelbase")}{gf("Width", "width")}
            {machineId === "custom" && (
              <div className="space-y-1 pt-1">
                <div className="flex items-center gap-1.5">
                  <label className="cursor-pointer text-[9px] px-2 py-1 rounded font-bold uppercase tracking-wider text-white shrink-0" style={{ backgroundColor: "#CD2027" }}>
                    {customImage ? "Replace Image" : "Machine Image"}
                    <input ref={imgFr} type="file" accept="image/png,image/jpeg" onChange={handleCustomImage} className="hidden" />
                  </label>
                  <span className="text-[9px] flex-1 truncate" style={{ color: customImage ? "#fff" : "#808285" }}>{customImage?.name ?? "No image (side profile, facing right)"}</span>
                </div>
                {customImgError && <div className="text-[9px]" style={{ color: "#FCB830" }}>{customImgError}</div>}
                {customImage && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px]" style={{ color: customCal ? "#7BC67B" : "#FCB830" }}>{customCal ? "✓ Calibrated" : "Not calibrated"}</span>
                    <button onClick={() => setCalModalOpen(true)} className="text-[9px] px-2 py-0.5 rounded text-white" style={{ backgroundColor: "#2B2E31" }}>{customCal ? "Recalibrate" : "Calibrate"}</button>
                    <button onClick={clearCustomImage} className="text-[9px] px-2 py-0.5 rounded" style={{ backgroundColor: "#3A3D41", color: "#A7A9AC" }}>✕ Clear</button>
                  </div>
                )}
              </div>
            )}
            {mach?.hasSwivel && (<>
              {gf("Swivel Pivot Y", "swivelPivotY")}
              <MotionInput label="Swivel Angle" min={-90} max={90} step={1} value={swivelAngle} onChange={v => setSwivelAngle(v)} unit="°" />
            </>)}
            {!mach?.hasArm && !mach?.hasLift && geo.hopperPivotY !== 0 && (<>
              {gf("Hopper Pivot Y", "hopperPivotY")}{gf("Hopper Pivot Z", "hopperPivotZ")}
              <MotionInput label="Dump Angle" min={0} max={67} step={1} value={armAngle} onChange={v => setArmAngle(v)} unit="°" />
            </>)}
            {mach?.hasLift && (<>
              {gf("Hopper Pivot Y", "hopperPivotY")}{gf("Hopper Pivot Z", "hopperPivotZ")}{gf("Max Lift Ht", "maxLiftHeight")}
              <MotionInput label="Lift Height" min={0} max={geo.maxLiftHeight} step={0.5} value={liftHeight} onChange={v => setLiftHeight(v)} unit="in." />
              <MotionInput label="Dump Angle" min={0} max={67} step={1} value={armAngle} onChange={v => setArmAngle(v)} unit="°" />
            </>)}
            {mach?.hasArm && (<>{gf("Arm Pivot Y", "armPivotY")}{gf("Arm Pivot Z", "armPivotZ")}{gf("Max Pin Ht", "maxPinHeight")}
              {mach.liftType === "vertical"
                ? <MotionInput label="Lift Height" min={0} max={geo.maxPinHeight} step={1} value={armAngle} onChange={v => setArmAngle(v)} unit="in." />
                : <MotionInput label="Arm Angle" min={armRestAngle} max={armSliderMax + armRestAngle} step={0.5}
                    value={armAngle + armRestAngle}
                    onChange={v => { setArmAngle(Math.max(0, v - armRestAngle)); setArmPreset(null); }} unit="°"
                    buttons={<>
                      <button onClick={() => { if (armPreset === 'reach') { setArmAngle(0); setArmPreset(null); } else { setArmAngle(Math.min(armSliderMax, maxReachAngle)); setArmPreset('reach'); } }} className="text-[7px] px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: armPreset === 'reach' ? "#CD2027" : "#2B2E31" }}>Max Reach</button>
                    </>} />}</>)}
          </div>
          <div className="flex border-b border-[#2B2E31]">
            {["components", "upload"].map(t => <button key={t} onClick={() => setTab(t)} className={`flex-1 text-[9px] uppercase tracking-wider py-1.5`} style={tab === t ? { color: "#CD2027", borderBottom: "2px solid #CD2027" } : { color: "#808285" }}>{t}</button>)}
          </div>
          {tab === "upload" && <div className="p-2.5 space-y-2">
            <p className="text-[9px] text-[#A7A9AC]">CSV: Component, X, Y, Z, Weight</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <label className="cursor-pointer text-[9px] px-2 py-1 rounded font-bold uppercase tracking-wider text-white shrink-0" style={{ backgroundColor: "#CD2027" }}>
                Choose File
                <input ref={fr} type="file" accept=".csv" onChange={handleFile} className="hidden" />
              </label>
              <span className="text-[9px] flex-1 truncate" style={{ color: fileName ? "#fff" : "#808285" }}>{fileName ?? "No file chosen"}</span>
            </div>
            {fileName && <button onClick={clearFile} className="text-[9px] px-2 py-0.5 rounded" style={{ backgroundColor: "#3A3D41", color: "#A7A9AC" }}>✕ Clear file</button>}
          </div>}
          {tab === "components" && <div className="flex-1 overflow-auto">
            <div className="p-2 border-b border-[#2B2E31] space-y-1">
              {mach?.hasArm && (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[9px] text-[#A7A9AC]">Attachment:</span>
                  <select
                    value=""
                    onChange={e => { if (e.target.value) applyAttachmentPreset(e.target.value); }}
                    className="bg-[#2B2E31] border border-[#3A3D41] text-[9px] rounded px-1 py-0.5 text-white"
                  >
                    <option value="">— select —</option>
                    <optgroup label="Standard">
                      {ATTACHMENT_PRESETS.filter(p => !p.name.startsWith("30")).map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                    </optgroup>
                    <optgroup label="30&quot;">
                      {ATTACHMENT_PRESETS.filter(p => p.name.startsWith("30")).map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                    </optgroup>
                  </select>
                </div>
              )}
              <div className="grid grid-cols-5 gap-1">
                {[["Name","name",2],["X","x"],["Y","y"],["Z","z"]].map(([p,k,s]) =>
                  <input key={k} placeholder={p} value={nc[k]} onChange={e => setNc(n => ({ ...n, [k]: e.target.value }))}
                    className={`${s ? "col-span-2" : ""} bg-[#2B2E31] border border-[#3A3D41] rounded px-1 py-0.5 text-[9px] text-white ${k !== "name" ? "text-right" : ""} placeholder-[#808285]`} />
                )}
              </div>
              <div className="flex gap-1">
                <input placeholder="Weight" value={nc.weight} onChange={e => setNc(n => ({ ...n, weight: e.target.value }))}
                  className="flex-1 bg-[#2B2E31] border border-[#3A3D41] rounded px-1 py-0.5 text-[9px] text-white text-right placeholder-[#808285]" />
                <button onClick={addC} className="text-white text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider" style={{ backgroundColor: "#CD2027" }}>+ADD</button>
              </div>
            </div>
            <div className="divide-y divide-[#2B2E31]">
              {comps.map(c => {
                const rank = sensRanking.findIndex(s => s.id === c.id);
                const rearRank = rearRanking.findIndex(s => s.id === c.id);
                return <div key={c.id} className={`px-2 py-1 text-[9px] ${c.enabled ? "" : "opacity-40"}`}>
                <div className="flex items-center gap-1">
                  <input type="checkbox" checked={c.enabled} onChange={() => togC(c.id)} className="w-3 h-3" style={{ accentColor: "#CD2027" }} />
                  <span className="font-bold text-white flex-1 truncate">{c.name}</span>
                  {rank >= 0 && <span className="text-[7px] font-bold px-1 rounded" style={{ backgroundColor: "#2B2E31", color: "#FCB830", border: "1px solid #FCB830" }}>F{rank + 1}</span>}
                  {rearRank >= 0 && <span className="text-[7px] font-bold px-1 rounded" style={{ backgroundColor: "#2B2E31", color: "#4A90D9", border: "1px solid #4A90D9" }}>R{rearRank + 1}</span>}
                  <button onClick={() => togArm(c.id)} className={`text-[7px] px-1 py-0.5 rounded text-white`} style={armIds.has(c.id) ? { backgroundColor: "#CD2027" } : { backgroundColor: "#2B2E31", color: "#A7A9AC" }}>{mach?.hasArm ? "ARM" : "DUMP"}</button>
                  {mach?.hasLift && <button onClick={() => togLift(c.id)} className={`text-[7px] px-1 py-0.5 rounded text-white`} style={liftIds.has(c.id) ? { backgroundColor: "#CD2027" } : { backgroundColor: "#2B2E31", color: "#A7A9AC" }}>LIFT</button>}
                  <button onClick={() => remC(c.id)} className="text-[#808285] text-[10px]" onMouseEnter={e => e.target.style.color='#CD2027'} onMouseLeave={e => e.target.style.color=''}>✕</button>
                </div>
                <div className="flex gap-1.5 mt-0.5 text-[#A7A9AC]">
                  {["x","y","z"].map(f => <span key={f}>{f.toUpperCase()}:<input type="number" value={c[f]} onChange={e => updC(c.id, f, e.target.value)} className="w-11 bg-transparent border-b border-[#3A3D41] text-white text-right ml-0.5 text-[9px]" /></span>)}
                  <span>W:<input type="number" value={c.weight} onChange={e => updC(c.id, "weight", e.target.value)} className="w-12 bg-transparent border-b border-[#3A3D41] text-white text-right ml-0.5 text-[9px]" /></span>
                </div>
              </div>; })}
              {comps.length === 0 && <div className="p-3 text-center text-[#808285] text-[10px]">No components yet.</div>}
            </div>
          </div>}
        </div>

        {/* CENTER */}
        <div className="flex-1 overflow-auto p-2.5 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5" style={{ height: svgHeight }}>
            <div className="bg-[#1A1A1A] border border-[#2B2E31] rounded-lg p-2.5 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-[9px] font-bold uppercase text-[#A7A9AC]">Top-Down (X vs Y)</h3>
                <button onClick={() => setTopDownExpanded(true)} className="text-[#4B4F54] hover:text-[#A7A9AC] text-[10px] leading-none" title="Expand">⛶</button>
              </div>
              <div className="flex-1 cursor-pointer" onClick={() => setTopDownExpanded(true)} title="Click to expand">
                <TopDown r={result} geo={geo} comps={comps} aa={armAngle} aids={armIds} sa={swivelAngle} showLabels={showLabels} />
              </div>
            </div>
            <div className="bg-[#1A1A1A] border border-[#2B2E31] rounded-lg p-2.5 flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-[9px] font-bold uppercase text-[#A7A9AC]">Side View (Y vs Z)</h3>
                <button onClick={() => setSideViewExpanded(true)} className="text-[#4B4F54] hover:text-[#A7A9AC] text-[10px] leading-none" title="Expand">⛶</button>
              </div>
              <div className="flex-1 cursor-pointer" onClick={() => setSideViewExpanded(true)} title="Click to expand">
                <SideView r={result} geo={geo} comps={comps} aa={armAngle} aids={armIds} sil={hasSil} machineId={machineId} showLabels={showLabels} svgRef={sideViewRef} liftHeight={liftHeight} liftIds={liftIds}sa={swivelAngle} customCal={customCal} />
              </div>
            </div>
          </div>

          <div className="bg-[#1A1A1A] border border-[#2B2E31] rounded-lg p-2.5">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="text-[9px] font-bold uppercase text-[#A7A9AC]">Placement Explorer</h3>
              <select value={sensId || ""} onChange={e => { setSensId(+e.target.value); resetTrial(); }} className="bg-[#2B2E31] border border-[#3A3D41] text-[9px] rounded px-1 py-0.5 text-white">
                {comps.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {/* Label toggle */}
              <button onClick={() => setShowLabels(s => !s)} title="Toggle component labels"
                className="text-[9px] px-1.5 py-0.5 rounded border"
                style={{ borderColor: "#3A3D41", backgroundColor: showLabels ? "#2B2E31" : "#1A1A1A", color: showLabels ? "#fff" : "#808285" }}>
                {showLabels ? "Labels ON" : "Labels OFF"}
              </button>
              {trial && <button onClick={undoTrial} className="text-[8px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "#2B2E31", color: "#FCB830" }}>Undo</button>}
              {trial && <button onClick={resetTrial} className="text-[8px] bg-[#3A3D41] text-white px-1.5 py-0.5 rounded">Reset</button>}
              {trial && <span className="text-[8px] text-[#808285]">Trial Y={trial.y.toFixed(1)} Z={trial.z.toFixed(1)} — see Δ in Results →</span>}
            </div>
            <Placer geo={geo} comps={comps} aa={armAngle} aids={armIds} sid={sensId} trial={trial} onPlace={pushTrial} sil={hasSil} machineId={machineId} showLabels={showLabels} result={result} liftHeight={liftHeight} liftIds={liftIds}sa={swivelAngle} customCal={customCal} />
          </div>

          {/* Bottom: sensitivity charts / heatmap */}
          <div className="bg-[#1A1A1A] border border-[#2B2E31] rounded-lg p-2.5">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <div className="relative flex rounded-full overflow-hidden border border-[#3A3D41]" style={{ backgroundColor: "#2B2E31" }}>
                <div className="absolute top-0 bottom-0 w-1/2 rounded-full transition-transform duration-200"
                  style={{ backgroundColor: "#CD2027", transform: centerTab === "heatmap" ? "translateX(100%)" : "translateX(0%)" }} />
                {["weight", "heatmap"].map(t => (
                  <button key={t} onClick={() => setCenterTab(t)}
                    className="relative z-10 text-[9px] uppercase tracking-wider px-3 py-1 transition-colors duration-200 min-w-[120px] text-center whitespace-nowrap"
                    style={{ color: centerTab === t ? "#fff" : "#808285", fontWeight: centerTab === t ? "bold" : "normal" }}>
                    {t === "weight" ? "Weight Sensitivity" : "2D Heatmap"}
                  </button>
                ))}
              </div>
              <select value={sensId || ""} onChange={e => setSensId(+e.target.value)} className="bg-[#2B2E31] border border-[#3A3D41] text-[9px] rounded px-1 py-0.5 text-white ml-1">
                {comps.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {centerTab === "weight" && <>
                <span className="text-[9px] text-[#A7A9AC]">Δ</span>
                <input type="number" value={wInc} onChange={e => setWInc(+e.target.value || 1)} className="w-10 bg-[#2B2E31] border border-[#3A3D41] rounded px-1 py-0.5 text-[9px] text-white text-right" />
                <span className="text-[9px] text-[#A7A9AC]">lbs/step</span>
              </>}
              {centerTab === "heatmap" && <>
                <span className="text-[9px] text-[#A7A9AC]">Δ</span>
                <input type="number" step="0.1" value={heatInc} onChange={e => setHeatInc(+e.target.value || 0.1)} className="w-12 bg-[#2B2E31] border border-[#3A3D41] rounded px-1 py-0.5 text-[9px] text-white text-right" />
                <span className="text-[9px] text-[#A7A9AC]">in./step</span>
              </>}
            </div>
            {centerTab === "weight" && (
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <div className="text-[8px] text-[#A7A9AC] mb-1 uppercase tracking-wider">Fwd Tip</div>
                  {fwdW?.vals?.length ? <WBar d={fwdW} lbl="Fwd Tip" cn={comps.find(c => c.id === sensId)?.name} /> : <div className="h-20 flex items-center justify-center text-[#808285] text-[10px]">Select component</div>}
                </div>
                <div>
                  <div className="text-[8px] text-[#A7A9AC] mb-1 uppercase tracking-wider">Rear Tip</div>
                  {rearW?.vals?.length ? <WBar d={rearW} lbl="Rear Tip" cn={comps.find(c => c.id === sensId)?.name} /> : <div className="h-20 flex items-center justify-center text-[#808285] text-[10px]">Select component</div>}
                </div>
              </div>
            )}
            {centerTab === "heatmap" && (
              heatmap
                ? <DualHeatMap data={heatmap} compName={comps.find(c => c.id === sensId)?.name} result={result} />
                : <div className="h-32 flex items-center justify-center text-[#808285] text-[10px]">Select a component to generate heatmap</div>
            )}
            {(sensRanking.length > 0 || rearRanking.length > 0) && (
              <div className="mt-2 border-t border-[#2B2E31] pt-2 flex gap-4">
                {sensRanking.length > 0 && (
                  <div className="flex-1 min-w-0">
                    <div className="text-[8px] font-bold uppercase tracking-wider text-[#FCB830] mb-1">Fwd Tip Sensitivity — Top 5</div>
                    <div className="grid gap-px" style={{ gridTemplateColumns: "1rem 1fr auto auto" }}>
                      <div className="text-[7px] text-[#4B4F54]">#</div>
                      <div className="text-[7px] text-[#4B4F54]">Component</div>
                      <div className="text-[7px] text-[#4B4F54] text-right pr-2">∂Fwd/∂Y</div>
                      <div className="text-[7px] text-[#4B4F54] text-right">∂Fwd/∂Z</div>
                      {sensRanking.map((s, i) => (
                        <React.Fragment key={s.id}>
                          <div className="text-[7px] font-bold" style={{ color: "#FCB830" }}>{i + 1}</div>
                          <div className="text-[7px] text-white truncate">{s.name}</div>
                          <div className="text-[7px] text-right pr-2 tabular-nums" style={{ color: "#A7A9AC"}}>{s.dY >= 0 ? "+" : ""}{s.dY.toFixed(2)}°/in</div>
                          <div className="text-[7px] text-right tabular-nums" style={{ color:"#A7A9AC"}}>{s.dZ >= 0 ? "+" : ""}{s.dZ.toFixed(2)}°/in</div>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
                {rearRanking.length > 0 && (
                  <div className="flex-1 min-w-0">
                    <div className="text-[8px] font-bold uppercase tracking-wider mb-1" style={{ color: "#4A90D9" }}>Rear Tip Sensitivity — Top 5</div>
                    <div className="grid gap-px" style={{ gridTemplateColumns: "1rem 1fr auto auto" }}>
                      <div className="text-[7px] text-[#4B4F54]">#</div>
                      <div className="text-[7px] text-[#4B4F54]">Component</div>
                      <div className="text-[7px] text-[#4B4F54] text-right pr-2">∂Rear/∂Y</div>
                      <div className="text-[7px] text-[#4B4F54] text-right">∂Rear/∂Z</div>
                      {rearRanking.map((s, i) => (
                        <React.Fragment key={s.id}>
                          <div className="text-[7px] font-bold" style={{ color: "#4A90D9" }}>{i + 1}</div>
                          <div className="text-[7px] text-white truncate">{s.name}</div>
                          <div className="text-[7px] text-right pr-2 tabular-nums" style={{ color: "#A7A9AC"}}>{s.dY >= 0 ? "+" : ""}{s.dY.toFixed(2)}°/in</div>
                          <div className="text-[7px] text-right tabular-nums" style={{ color: "#A7A9AC"}}>{s.dZ >= 0 ? "+" : ""}{s.dZ.toFixed(2)}°/in</div>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="w-56 bg-[#1A1A1A] border-l border-[#2B2E31] overflow-auto shrink-0">
          <div className="p-2.5">
            <h2 className="text-[9px] font-bold uppercase text-[#A7A9AC] mb-2">Results</h2>
            {result ? <div className="space-y-2.5">
              <S t="Center of Gravity"><R l="CG, X" v={result.cgX.toFixed(1)} u="in." /><R l="CG, Y" v={result.cgY.toFixed(1)} u="in." /><R l="CG, Z" v={result.cgZ.toFixed(1)} u="in." /><R l="Total Wt" v={result.totalW.toFixed(1)} u="lbs" /></S>
              <S t="Tipping Angles"><TR l="Forward" v={result.fwdTip} base={trial ? baseRes?.fwdTip : null} p={pf(result.fwdTip, "lon")} /><TR l="Rear" v={result.rearTip} base={trial ? baseRes?.rearTip : null} p={pf(result.rearTip, "lon")} /><TR l="Left" v={result.leftTip} p={pf(result.leftTip, "lat")} /><TR l="Right" v={result.rightTip} p={pf(result.rightTip, "lat")} /></S>
              <S t="Weight Distribution"><R l="% Front" v={(result.pctFront * 100).toFixed(1)} u="%" /><R l="% Rear" v={((1 - result.pctFront) * 100).toFixed(1)} u="%" /></S>
              <S t="Corner Weights"><R l="Front Left" v={result.fl.toFixed(1)} u="lbs" /><R l="Front Right" v={result.fr.toFixed(1)} u="lbs" /><R l="Rear Left" v={result.rl.toFixed(1)} u="lbs" /><R l="Rear Right" v={result.rr.toFixed(1)} u="lbs" /></S>
              {mach?.k && <S t="ROC"><R l="Stability Factor (k)" v={mach.k.toFixed(2)} u="" />
                {roc ? <><R l="Tipping Load" v={roc.mTip.toFixed(1)} u="lbs" /><R l="ROC" v={roc.roc.toFixed(1)} u="lbs" /><R l={geo.liftType === "vertical" ? "Max Lift Ht" : "Max Reach∠"} v={geo.liftType === "vertical" ? roc.maxAngle : (parseFloat(roc.maxAngle) + armRestAngle).toFixed(1)} u={geo.liftType === "vertical" ? "in." : "°"} /></> : <div className="text-[8px] text-[#808285] italic">Add "Load" component for ROC</div>}</S>}
            </div> : <div className="text-center text-[#808285] text-[10px] py-6">Add components</div>}
            <div className="mt-3 pt-2 border-t border-[#2B2E31]">
              <button onClick={exportPDF} disabled={!result} className="w-full text-[9px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded border" style={{ borderColor: result ? "#CD2027" : "#3A3D41", color: result ? "#fff" : "#fff", backgroundColor: "#CD2027", cursor: result ? "pointer" : "not-allowed", opacity: result ? 1 : 0.5 }}>Export Results</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    {topDownExpanded && (
      <div className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.88)' }}
        onClick={() => setTopDownExpanded(false)}>
        <div className="relative flex flex-col rounded-lg border border-[#2B2E31]"
          style={{ width: '95vw', height: '92vh', backgroundColor: '#1A1A1A' }}
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2B2E31] shrink-0">
            <h3 className="text-[11px] font-bold uppercase text-[#A7A9AC] tracking-wider">Top-Down (X vs Y)</h3>
            <button onClick={() => setTopDownExpanded(false)} className="text-[#A7A9AC] hover:text-white text-2xl leading-none px-1">×</button>
          </div>
          <div className="flex-1 min-h-0 p-3">
            <TopDown r={result} geo={geo} comps={comps} aa={armAngle} aids={armIds} sa={swivelAngle} showLabels={showLabels} />
          </div>
        </div>
      </div>
    )}
    {calModalOpen && customImage && (
      <CalibrationModal image={customImage} initialPts={customCalPts} wheelbase={geo.wheelbase}
        onConfirm={pts => { setCustomCalPts(pts); setCalModalOpen(false); }}
        onCancel={() => setCalModalOpen(false)} />
    )}
    {sideViewExpanded && (
      <div className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.88)' }}
        onClick={() => setSideViewExpanded(false)}>
        <div className="relative flex flex-col rounded-lg border border-[#2B2E31]"
          style={{ width: '95vw', height: '92vh', backgroundColor: '#1A1A1A' }}
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2B2E31] shrink-0">
            <h3 className="text-[11px] font-bold uppercase text-[#A7A9AC] tracking-wider">Side View (Y vs Z)</h3>
            <button onClick={() => setSideViewExpanded(false)} className="text-[#A7A9AC] hover:text-white text-2xl leading-none px-1">×</button>
          </div>
          <div className="flex-1 min-h-0 p-3">
            <SideView r={result} geo={geo} comps={comps} aa={armAngle} aids={armIds} sil={hasSil} machineId={machineId} showLabels={showLabels} liftHeight={liftHeight} liftIds={liftIds}sa={swivelAngle} customCal={customCal} />
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function S({ t, children }) { return <div><div className="text-[8px] font-bold uppercase tracking-widest mb-0.5" style={{ color: "#CD2027", letterSpacing: "0.15em" }}>{t}</div><div className="space-y-0.5">{children}</div></div>; }
function R({ l, v, u }) { return <div className="flex items-center text-[10px]"><span className="text-[#A7A9AC] flex-1">{l}</span><span className="text-white font-bold tabular-nums">{v}</span><span className="text-[#808285] ml-1 text-[8px]">{u}</span></div>; }
// Custom machine image calibration: user clicks rear then front axle ground-contact points
// on the image at natural resolution; both stay draggable. Returns raw points + optional
// tilt override; deriveCustomCal turns them into a MACHINE_CAL-shaped object.
function CalibrationModal({ image, initialPts, wheelbase, onConfirm, onCancel }) {
  const [rear, setRear] = useState(initialPts?.rear ?? null);
  const [front, setFront] = useState(initialPts?.front ?? null);
  const [tiltDraft, setTiltDraft] = useState(initialPts?.tiltOverride != null ? String(initialPts.tiltOverride) : "");
  const [dragging, setDragging] = useState(null); // "rear" | "front" | null
  const svgRef = useRef(null);
  const { img, imgW, imgH } = image;
  const handleR = Math.max(imgW, imgH) * 0.01;

  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Screen → image pixel coords; getScreenCTM handles viewBox letterboxing (same as Placer).
  const toImgPx = e => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.min(imgW, Math.max(0, p.x)), Math.min(imgH, Math.max(0, p.y))];
  };
  const onClick = e => {
    if (dragging) return;
    if (!rear) setRear(toImgPx(e));
    else if (!front) setFront(toImgPx(e));
  };
  const onMove = e => {
    if (!dragging) return;
    (dragging === "rear" ? setRear : setFront)(toImgPx(e));
  };

  const autoTilt = rear && front ? -Math.atan2(front[1] - rear[1], front[0] - rear[0]) * 180 / Math.PI : null;
  const tiltOverride = tiltDraft.trim() === "" || isNaN(parseFloat(tiltDraft)) ? null : parseFloat(tiltDraft);
  const blocker = !(wheelbase > 0) ? "Enter a wheelbase greater than 0 first."
    : !rear ? null : !front ? null
    : front[0] <= rear[0] ? "Front point must be right of rear — image must face right." : null;
  const canConfirm = rear && front && !blocker;
  const prompt = !rear ? "Click the REAR axle ground-contact point" : !front ? "Click the FRONT axle ground-contact point" : "Drag points to fine-tune, then Confirm";

  const handle = (key, p, color) => p && <g>
    <circle cx={p[0]} cy={p[1]} r={handleR} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={handleR * 0.25}
      style={{ cursor: "grab" }} onPointerDown={e => { e.stopPropagation(); setDragging(key); }} />
    <text x={p[0]} y={p[1] + handleR * 2.6} textAnchor="middle" fill={color} fontSize={handleR * 1.6} fontWeight="bold">{key === "rear" ? "REAR" : "FRT"}</text>
  </g>;

  return <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.88)" }}>
    <div className="bg-[#1A1A1A] border border-[#3A3D41] rounded p-3 flex flex-col gap-2" style={{ width: "min(92vw, 1100px)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-white">Calibrate Machine Image</h2>
        <span className="text-[10px]" style={{ color: "#FCB830" }}>{prompt}</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${imgW} ${imgH}`} className="w-full cursor-crosshair select-none" style={{ maxHeight: "65vh", backgroundColor: "#0a0a0a", touchAction: "none" }}
        onClick={onClick} onPointerMove={onMove} onPointerUp={() => setTimeout(() => setDragging(null), 0)} onPointerLeave={() => setDragging(null)}>
        <image href={img} x={0} y={0} width={imgW} height={imgH} />
        {rear && front && <line x1={rear[0]} y1={rear[1]} x2={front[0]} y2={front[1]} stroke="#FCB830" strokeWidth={handleR * 0.3} strokeDasharray={`${handleR},${handleR * 0.6}`} />}
        {handle("rear", rear, "#4A90D9")}
        {handle("front", front, "#CD2027")}
      </svg>
      <div className="flex items-center gap-3 text-[10px] flex-wrap">
        <span className="text-[#A7A9AC]">Wheelbase: <span className="text-white font-bold">{wheelbase > 0 ? `${wheelbase} in.` : "—"}</span></span>
        <span className="text-[#A7A9AC]">Auto tilt: <span className="text-white font-bold">{autoTilt != null ? `${autoTilt.toFixed(2)}°` : "—"}</span></span>
        <label className="text-[#A7A9AC] flex items-center gap-1">Tilt override
          <input type="number" step={0.1} value={tiltDraft} placeholder="auto" onChange={e => setTiltDraft(e.target.value)}
            className="w-16 text-right text-white text-[10px] bg-[#1a1a1a] border border-[#3a3a3a] rounded px-1 outline-none" />°
        </label>
        {blocker && <span style={{ color: "#FCB830" }}>{blocker}</span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => { setRear(null); setFront(null); }} className="text-[9px] px-2 py-1 rounded" style={{ backgroundColor: "#3A3D41", color: "#A7A9AC" }}>Reset Points</button>
          <button onClick={onCancel} className="text-[9px] px-2 py-1 rounded" style={{ backgroundColor: "#3A3D41", color: "#A7A9AC" }}>Cancel</button>
          <button disabled={!canConfirm} onClick={() => onConfirm({ rear, front, tiltOverride })}
            className="text-[9px] px-3 py-1 rounded font-bold uppercase tracking-wider text-white"
            style={{ backgroundColor: canConfirm ? "#CD2027" : "#4B4F54", cursor: canConfirm ? "pointer" : "not-allowed" }}>Confirm</button>
        </div>
      </div>
    </div>
  </div>;
}

// base = angle from baseRes (no trial). When a trial placement is active, shows Δ in amber.
function TR({ l, v, base, p }) {
  const angleColor = p.pass === null ? (v < 15 ? "#CD2027" : "#fff") : p.pass ? "#86efac" : "#CD2027";
  const stdMargin = p.threshold !== null && p.threshold !== undefined ? v - p.threshold : null;
  const delta = base != null ? v - base : null;
  return (
    <div className="flex items-center text-[10px]">
      <span className="text-[#A7A9AC] flex-1">{l}</span>
      <span className="font-bold tabular-nums" style={{ color: angleColor }}>{v.toFixed(1)}°</span>
      {delta !== null && (
        <span className="ml-1 text-[8px] tabular-nums font-bold" style={{ color: delta >= 0 ? "#86efac" : "#CD2027" }}>
          {delta >= 0 ? "▲" : "▼"}{Math.abs(delta).toFixed(1)}°
        </span>
      )}
      {stdMargin !== null && (
        <span className="ml-1 text-[8px] tabular-nums" style={{ color: stdMargin >= 0 ? "#86efac" : "#CD2027" }}>
          {stdMargin >= 0 ? "+" : ""}{stdMargin.toFixed(1)}°
        </span>
      )}
      {p.pass !== null && (
        <span className="ml-1 text-[7px] font-bold px-1 py-0.5 rounded" style={p.pass ? { backgroundColor: "#14532d", color: "#86efac" } : { backgroundColor: "#3d0a0a", color: "#CD2027" }}>
          {p.pass ? "PASS" : "FAIL"}
        </span>
      )}
    </div>
  );
}

// Flipped X: front (Y=0) on the RIGHT, rear (Y=-wheelbase) on the LEFT.
// This matches a left-side profile view — negative Y (forward/bucket) extends to the right.
// centerX=false (SideView): front anchored near right edge, leaving room for arm extension right.
// centerX=true (Placer): wheelbase span centered, front at right end of centered span.
function useSVT(geo, comps, aa, aids, w, h, pad, scMult = 1, machineId = null, liftHeight = 0, liftIds = new Set(), sa = 0, customCal = null) {
  const pts = comps.filter(c => c.enabled).map(c => getEffPos(c, geo, aa, aids, liftHeight, liftIds, sa));
  // For buggies, extend yMax by a modest amount so the front of the machine is visible.
  // Capped at 20% of wheelbase to avoid over-zooming; Dingo arm data handles front extent naturally.
  const yFrontBuf = geo.armPivotY === 0 && geo.hopperPivotY !== 0 ? geo.wheelbase * 0.20 : 0;
  const cal = machineId ? resolveMachineCal(machineId, customCal) : null;
  const allY = [0, -geo.wheelbase, ...(yFrontBuf > 0 ? [yFrontBuf] : []), ...(geo.armPivotY !== 0 ? [geo.armPivotY] : []), ...(geo.hopperPivotY !== 0 ? [geo.hopperPivotY] : []), ...pts.map(p => p.y), ...getCustomImageYExtent(machineId, cal, geo)];
  const allZ = [0, ...(geo.armPivotY !== 0 ? [geo.armPivotZ] : []), ...(geo.hopperPivotY !== 0 ? [geo.hopperPivotZ] : []), ...pts.map(p => p.z)];
  const yBuf = (Math.max(...allY) - Math.min(...allY)) * 0.10;
  const yMin = Math.min(...allY) - yBuf, yMax = Math.max(...allY) + yBuf;
  const zMax = (() => {
    let z = pts.length ? Math.max(...allZ, 5) : 0;
    // Always include image top height so the machine image stays in frame after file load.
    if (cal && geo.wheelbase > 0) {
      const useUpSVT = liftHeight > 0 && !!cal.imgUp;
      const srcW = useUpSVT ? cal.imgUpW : cal.imgW;
      const srcH = useUpSVT ? cal.imgUpH : cal.imgH;
      const fA = useUpSVT && cal.frontAxleUp != null ? cal.frontAxleUp : cal.frontAxle;
      const rA = useUpSVT && cal.rearAxleUp  != null ? cal.rearAxleUp  : cal.rearAxle;
      const zm = useUpSVT && cal.zoomMultUp  != null ? cal.zoomMultUp  : (cal.zoomMult ?? 1);
      const gY = useUpSVT && cal.groundYUp   != null ? cal.groundYUp   : cal.groundY;
      const pxPerIn = srcW * Math.abs(fA - rA) / geo.wheelbase;
      if (pxPerIn > 0) z = Math.max(z, gY * srcH / pxPerIn * zm);
    }
    return z || geo.maxPinHeight / 2 || 60;
  })();
  const scH = (w - 2 * pad) / Math.max(yMax - yMin, 1);
  const scV = (h - 2 * pad) / Math.max(zMax, 1);
  const sc = Math.min(scH, scV) * scMult;
  // Buggies: center on fixed machine footprint so position doesn't shift when data loads.
  // Dingos: center on data span as before.
  const isBuggy = geo.armPivotY === 0 && geo.hopperPivotY !== 0;
  const spanW = (yMax - yMin) * sc;
  const oX = isBuggy
    ? w / 2 + (geo.wheelbase / 2 - yFrontBuf / 2) * sc + 20
    : (w - spanW) / 2 - yMin * sc;
  const spanH = zMax * sc;
  const oY = h - (h - spanH) / 2 - 20;
  const to = (y, z) => [oX + y * sc, oY - z * sc];
  const from = (sx, sy) => [(sx - oX) / sc, -(sy - oY) / sc];
  return { to, from, sc, oY };
}

// TX1000 silhouette body points (Y, Z machine coords)
const BODY = [[2,0],[2,8],[-2,10],[-2,14],[-6,18],[-6,24],[-8,26],[-10,32],[-14,36],[-18,38],[-22,40],[-24,42],[-28,42],[-30,38],[-30,32],[-28,26],[-26,20],[-26,16],[-28,10],[-30,8],[-30,4],[-28,0]];

// AxisBug: small coordinate system indicator for bottom-left of SVG views
// ax1/ay1 = first axis label+direction, ax2/ay2 = second axis label+direction
// cx/cy = bottom-left anchor point in SVG coords
function AxisBug({ cx, cy, a1, a2 }) {
  const len = 28, r = 3, fs = 8;
  const col = "#A7A9AC", lblCol = "#ffffff";
  // a1 = horizontal (right), a2 = vertical (up in SVG = negative y)
  const ox = cx + r + 2, oy = cy - r - 2;
  const a1x = ox + len, a1y = oy;
  const a2x = ox, a2y = oy - len;
  // arrowhead helper
  const arr = (x, y, dir) => dir === 'r'
    ? `M${x-5},${y-3} L${x},${y} L${x-5},${y+3}`
    : `M${x-3},${y+5} L${x},${y} L${x+3},${y+5}`;
  return <g opacity={0.7}>
    <line x1={ox} y1={oy} x2={a1x} y2={a1y} stroke={col} strokeWidth={1} />
    <path d={arr(a1x, a1y, 'r')} stroke={col} strokeWidth={1} fill="none" />
    <line x1={ox} y1={oy} x2={a2x} y2={a2y} stroke={col} strokeWidth={1} />
    <path d={arr(a2x, a2y, 'u')} stroke={col} strokeWidth={1} fill="none" />
    <circle cx={ox} cy={oy} r={2} fill={col} />
    <text x={ox} y={oy+10} textAnchor="middle" fill={lblCol} fontSize={fs-1} fontWeight="bold">O</text>
    <text x={a1x+5} y={a1y+3} textAnchor="start" fill={lblCol} fontSize={fs} fontWeight="bold">{a1}</text>
    <text x={a2x} y={a2y-4} textAnchor="middle" fill={lblCol} fontSize={fs} fontWeight="bold">{a2}</text>
  </g>;
}

function Sil({ to, op }) {
  const pts = BODY.map(([y, z]) => to(y, z).join(",")).join(" ");
  return <g opacity={op}><polygon points={pts} fill="#A7A9AC" stroke="#A7A9AC" strokeWidth={0.5} />
    {[[-28,0,-28,6],[2,0,2,6],[-28,3,2,3]].map(([y1,z1,y2,z2], i) => { const [x1,yy1]=to(y1,z1);const[x2,yy2]=to(y2,z2); return <line key={i} x1={x1} y1={yy1} x2={x2} y2={yy2} stroke="#4B4F54" strokeWidth={2} />; })}</g>;
}

function TopDown({ r, geo, comps, aa, aids, sa = 0, showLabels = true }) {
  const { wheelbase: wb, width: wd } = geo;
  const pad = 15, w = 400, h = 360;
  const sc = Math.min((w - 2 * pad) / (wd * 1.3 || 1), (h - 2 * pad) / (wb * 1.3 || 1));
  const ox = w / 2, oy = pad + wb * sc * 0.15;
  const t = (x, y) => [ox + (x - wd / 2) * sc, oy + (-y) * sc];
  const [x0,y0]=t(0,0),[x1,y1]=t(wd,0),[x2,y2]=t(wd,-wb),[x3,y3]=t(0,-wb);
  return <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full">
    <rect width={w} height={h} fill="#0a0a0a" rx={4} />
    <polygon points={`${x0},${y0} ${x1},${y1} ${x2},${y2} ${x3},${y3}`} fill="none" stroke="#2B2E31" strokeWidth={1.5} strokeDasharray="4,2" />
    <text x={ox} y={y0+13} textAnchor="middle" fill="#4B4F54" fontSize={9}>FRONT</text>
    <text x={ox} y={y2-5} textAnchor="middle" fill="#4B4F54" fontSize={9}>REAR</text>
    {comps.filter(c=>c.enabled).map(c => { const p=getEffPos(c,geo,aa,aids,0,new Set(),sa);const[sx,sy]=t(p.x,p.y); return <g key={c.id}><circle cx={sx} cy={sy} r={3.5} fill={aids.has(c.id)?"#FCB830":"#4B4F54"} opacity={0.7}/>{showLabels&&<text x={sx+5} y={sy-4} fill="#4B4F54" fontSize={7}>{c.name.slice(0,12)}</text>}</g>; })}
    {r && (()=>{ const[cx,cy]=t(r.cgX,r.cgY); return <g><line x1={cx-7} y1={cy} x2={cx+7} y2={cy} stroke="#CD2027" strokeWidth={1.5}/><line x1={cx} y1={cy-7} x2={cx} y2={cy+7} stroke="#CD2027" strokeWidth={1.5}/><circle cx={cx} cy={cy} r={6} fill="none" stroke="#CD2027" strokeWidth={1.5}/><text x={cx+9} y={cy-5} fill="#CD2027" fontSize={9} fontWeight="bold">CG</text></g>; })()}
    {(()=>{ const[ox,oy]=t(0,0); return <g><circle cx={ox} cy={oy} r={4} fill="#2B2E31" stroke="#A7A9AC" strokeWidth={1}/><text x={ox+6} y={oy-4} fill="#A7A9AC" fontSize={8} fontWeight="bold">O</text></g>; })()}
    <AxisBug cx={14} cy={h-10} a1="X" a2="Y" />
  </svg>;
}

function SideView({ r, geo, comps, aa, aids, sil, machineId, showLabels = true, svgRef, liftHeight = 0, liftIds = new Set(), sa = 0, customCal = null }) {
  const pad = 15, w = 400, h = 360;
  const { to, oY } = useSVT(geo, comps, aa, aids, w, h, pad, 1, machineId, liftHeight, liftIds, sa, customCal);
  const mip = getMachineImageProps(machineId, to, geo, 1, liftHeight, customCal);
  return <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`} className="w-full h-full">
    <defs><clipPath id="sv-clip"><rect width={w} height={h} /></clipPath></defs>
    <rect width={w} height={h} fill="#0a0a0a" rx={4} />
    {mip && (() => {
      const cal = resolveMachineCal(machineId, customCal);
      const tilt = cal?.tilt ?? 0;
      const [rpx, rpy] = to(-geo.wheelbase, 0); // rotate around rear tipping point
      return <image href={mip.href} x={mip.x} y={mip.y} width={mip.width} height={mip.height}
        opacity={0.4} preserveAspectRatio="none" clipPath="url(#sv-clip)"
        transform={tilt ? `rotate(${tilt},${rpx},${rpy})` : undefined} />;
    })()}
    <line x1={pad} y1={oY} x2={w-pad} y2={oY} stroke="#2B2E31" strokeWidth={1} />
    {!mip && sil && <Sil to={to} op={0.12} />}
    {r&&(()=>{
      const[fx,fy]=to(0,0);const[rx,ry]=to(-geo.wheelbase,0);
      const[cgx,cgy]=to(r.cgY,r.cgZ);
      // Tipping angle lines: from each tip point through CG, extended 3x
      const fwdX2=fx+(cgx-fx)*4, fwdY2=fy+(cgy-fy)*4;
      const rearX2=rx+(cgx-rx)*4, rearY2=ry+(cgy-ry)*4;
      return <g>
        <line x1={fx} y1={fy} x2={fwdX2} y2={fwdY2} stroke="#A7A9AC" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.18} clipPath="url(#sv-clip)" />
        <line x1={rx} y1={ry} x2={rearX2} y2={rearY2} stroke="#A7A9AC" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.18} clipPath="url(#sv-clip)" />
      </g>;
    })()}
    {(()=>{ const[fx,fy]=to(0,0);const[rx,ry]=to(-geo.wheelbase,0); return <g>
      <circle cx={fx} cy={fy} r={4} fill="#2B2E31" stroke="#A7A9AC" strokeWidth={1}/>
      <text x={fx} y={fy+14} textAnchor="middle" fill="#A7A9AC" fontSize={8} fontWeight="bold">O</text>
      <circle cx={rx} cy={ry} r={4} fill="#2B2E31"/>
      <text x={rx} y={ry+13} textAnchor="middle" fill="#4B4F54" fontSize={8}>REAR</text>
    </g>; })()}
    {geo.armPivotY!==0&&(()=>{ const[px,py]=to(geo.armPivotY,geo.armPivotZ); return <g><circle cx={px} cy={py} r={3} fill="#FCB830"/><text x={px+6} y={py-4} fill="#FCB830" fontSize={10}>Arm Pivot</text></g>; })()}
    {geo.pinY!=null&&(()=>{ const rp=geo.liftType==="vertical"?{y:geo.pinY,z:geo.pinZ+aa}:getRotatedPosition(geo.pinY,geo.pinZ,geo.armPivotY,geo.armPivotZ,aa); const[px,py]=to(rp.y,rp.z); return <g><circle cx={px} cy={py} r={3} fill="#FCB830"/><text x={px+6} y={py-4} fill="#FCB830" fontSize={10}>Pin</text></g>; })()}
    {geo.hopperPivotY!==0&&(()=>{ const liveZ=geo.hopperPivotZ+liftHeight; const[px,py]=to(geo.hopperPivotY,liveZ); return <g><circle cx={px} cy={py} r={3} fill="#FCB830"/><text x={px+6} y={py-4} fill="#FCB830" fontSize={10}>Hopper Pivot</text></g>; })()}
    {(()=>{ const pivY=geo.armPivotY!==0?geo.armPivotY:geo.hopperPivotY; const pivZ=geo.armPivotY!==0?geo.armPivotZ:geo.hopperPivotZ+liftHeight; if(!pivY)return null; const ac=comps.filter(c=>c.enabled&&aids.has(c.id)); if(ac.length===0)return null; const[px,py]=to(pivY,pivZ); const sorted=ac.map(c=>({c,p:getEffPos(c,geo,aa,aids,liftHeight,liftIds,sa)})).sort((a,b)=>a.p.y-b.p.y); const pts=[[px,py],...sorted.map(({p})=>to(p.y,p.z))].map(([x,y])=>`${x},${y}`).join(' '); return <polyline points={pts} fill="none" stroke="#FCB830" strokeWidth={1} strokeDasharray="4,3" opacity={0.5}/>; })()}
    {comps.filter(c=>c.enabled).map(c=>{ const p=getEffPos(c,geo,aa,aids,liftHeight,liftIds,sa);const[sx,sy]=to(p.y,p.z); return <g key={c.id}><circle cx={sx} cy={sy} r={3.5} fill={aids.has(c.id)||liftIds.has(c.id)?"#FCB830":"#4B4F54"} opacity={0.7}/>{showLabels&&<text x={sx+5} y={sy-4} fill="#4B4F54" fontSize={7}>{c.name.slice(0,12)}</text>}</g>; })}
    {r&&(()=>{ const[cx,cy]=to(r.cgY,r.cgZ); return <g><line x1={cx-7} y1={cy} x2={cx+7} y2={cy} stroke="#CD2027" strokeWidth={1.5}/><line x1={cx} y1={cy-7} x2={cx} y2={cy+7} stroke="#CD2027" strokeWidth={1.5}/><circle cx={cx} cy={cy} r={6} fill="none" stroke="#CD2027" strokeWidth={1.5}/><text x={cx+9} y={cy-5} fill="#CD2027" fontSize={9} fontWeight="bold">CG</text></g>; })()}
    <AxisBug cx={14} cy={h-10} a1="Y" a2="Z" />
  </svg>;
}

function Placer({ geo, comps, aa, aids, sid, trial, onPlace, sil, machineId, showLabels, result, liftHeight = 0, liftIds = new Set(), sa = 0, customCal = null }) {
  const w = 620, h = 260;
  const margin = 20;

  // Auto-fit: compute Y/Z bounding box from all enabled components + machine boundary,
  // then scale so everything fits with equal margin on all four sides.
  const allPts = comps.filter(c => c.enabled).map(c => getEffPos(c, geo, aa, aids, liftHeight, liftIds, sa));
  const yFrontBufPlacer = geo.armPivotY === 0 && geo.hopperPivotY !== 0 ? geo.wheelbase * 0.20 : 0;
  const yVals = [0, -geo.wheelbase, ...(yFrontBufPlacer > 0 ? [yFrontBufPlacer] : []), ...(geo.hopperPivotY !== 0 ? [geo.hopperPivotY] : []), ...allPts.map(p => p.y),
    ...getCustomImageYExtent(machineId, resolveMachineCal(machineId, customCal), geo)];
  const zVals = [0, ...allPts.map(p => p.z)];
  const yRaw = { min: Math.min(...yVals), max: Math.max(...yVals) };
  const yBuf = (yRaw.max - yRaw.min) * 0.10;
  const yMin = yRaw.min - yBuf, yMax = yRaw.max + yBuf;
  const zMin = 0, zMax = (() => {
    let z = allPts.length ? Math.max(...zVals, 5) : 0;
    // Always include image top height so the machine image stays in frame after file load.
    const cal = machineId ? resolveMachineCal(machineId, customCal) : null;
    if (cal && geo.wheelbase > 0) {
      const useUpPlacer = liftHeight > 0 && !!cal.imgUp;
      const srcW = useUpPlacer ? cal.imgUpW : cal.imgW;
      const srcH = useUpPlacer ? cal.imgUpH : cal.imgH;
      const fA = useUpPlacer && cal.frontAxleUp != null ? cal.frontAxleUp : cal.frontAxle;
      const rA = useUpPlacer && cal.rearAxleUp  != null ? cal.rearAxleUp  : cal.rearAxle;
      const zm = useUpPlacer && cal.placerZoomMultUp != null ? cal.placerZoomMultUp : (cal.placerZoomMult ?? cal.zoomMult ?? 1);
      const gY = useUpPlacer && cal.groundYUp   != null ? cal.groundYUp   : cal.groundY;
      const pxPerIn = srcW * Math.abs(fA - rA) / geo.wheelbase;
      if (pxPerIn > 0) z = Math.max(z, gY * srcH / pxPerIn * zm);
    }
    return z || geo.maxPinHeight / 2 || 60;
  })();
  const scY = (w - 2 * margin) / Math.max(yMax - yMin, 1);
  const scZ = (h - 2 * margin) / Math.max(zMax - zMin, 1);
  const sc = Math.min(scY, scZ);
  const isBuggyPlacer = geo.armPivotY === 0 && geo.hopperPivotY !== 0;
  const spanW = (yMax - yMin) * sc;
  const spanH = (zMax - zMin) * sc;
  const oX = isBuggyPlacer
    ? w / 2 + (geo.wheelbase / 2 - yFrontBufPlacer / 2) * sc + 30
    : (w - spanW) / 2 - yMin * sc;
  const oY = h - (h - spanH) / 2;
  const to = (y, z) => [oX + y * sc, oY - z * sc];
  const from = (sx, sy) => [(sx - oX) / sc, -(sy - oY) / sc];

  const comp = comps.find(c => c.id === sid);
  const aPos = comp ? getEffPos(comp, geo, aa, aids, liftHeight, liftIds, sa) : null;
  const mip = getMachineImageProps(machineId, to, geo, 1, liftHeight, customCal);
  const click = e => {
    if (!comp) return;
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
    const [my, mz] = from(svgPt.x, svgPt.y);
    onPlace({ y: Math.round(my * 10) / 10, z: Math.max(0, Math.round(mz * 10) / 10) });
  };
  return <svg viewBox={`0 0 ${w} ${h}`} className="w-full cursor-crosshair" style={{ maxHeight: 240 }} onClick={click}>
    <defs><clipPath id="pl-clip"><rect width={w} height={h} /></clipPath></defs>
    <rect width={w} height={h} fill="#0a0a0a" rx={4} />
    {mip && (() => {
      const cal = resolveMachineCal(machineId, customCal);
      const tilt = cal?.tilt ?? 0;
      const [rpx, rpy] = to(-geo.wheelbase, 0);
      return <image href={mip.href} x={mip.x} y={mip.y} width={mip.width} height={mip.height}
        opacity={0.4} preserveAspectRatio="none" clipPath="url(#pl-clip)"
        transform={tilt ? `rotate(${tilt},${rpx},${rpy})` : undefined} />;
    })()}
    <line x1={margin} y1={oY} x2={w-margin} y2={oY} stroke="#2B2E31" strokeWidth={1} />
    {!mip && sil && <Sil to={to} op={0.13} />}
    {result&&(()=>{
      const[fx,fy]=to(0,0);const[rx,ry]=to(-geo.wheelbase,0);
      const[cgx,cgy]=to(result.cgY,result.cgZ);
      const fwdX2=fx+(cgx-fx)*4, fwdY2=fy+(cgy-fy)*4;
      const rearX2=rx+(cgx-rx)*4, rearY2=ry+(cgy-ry)*4;
      return <g>
        <line x1={fx} y1={fy} x2={fwdX2} y2={fwdY2} stroke="#A7A9AC" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.18} clipPath="url(#pl-clip)" />
        <line x1={rx} y1={ry} x2={rearX2} y2={rearY2} stroke="#A7A9AC" strokeWidth={0.8} strokeDasharray="4,3" opacity={0.18} clipPath="url(#pl-clip)" />
      </g>;
    })()}
    {(()=>{ const[fx,fy]=to(0,0);const[rx,ry]=to(-geo.wheelbase,0); return <g><circle cx={fx} cy={fy} r={3} fill="#2B2E31"/><text x={fx} y={fy+10} textAnchor="middle" fill="#4B4F54" fontSize={7}>FRT</text><circle cx={rx} cy={ry} r={3} fill="#2B2E31"/><text x={rx} y={ry+10} textAnchor="middle" fill="#4B4F54" fontSize={7}>REAR</text></g>; })()}
    {comps.filter(c=>c.enabled).map(c=>{ const p=getEffPos(c,geo,aa,aids,liftHeight,liftIds,sa);const[sx,sy]=to(p.y,p.z);const is=c.id===sid;
      return <g key={c.id}><circle cx={sx} cy={sy} r={is?5:2.5} fill={is?"#CD2027":"#4B4F54"} opacity={is?1:0.4} stroke={is?"#CD2027":"none"} strokeWidth={is?2:0}/>{showLabels&&(is?<text x={sx+8} y={sy-5} fill="#CD2027" fontSize={8} fontWeight="bold">{c.name} (actual)</text>:<text x={sx+4} y={sy-3} fill="#4B4F54" fontSize={7}>{c.name.slice(0,10)}</text>)}</g>; })}
    {trial&&(()=>{ const[tx,ty]=to(trial.y,trial.z);
      const dYStr = aPos ? ((trial.y-aPos.y)>=0?'+':'')+((trial.y-aPos.y).toFixed(1)) : null;
      const dZStr = aPos ? ((trial.z-aPos.z)>=0?'+':'')+((trial.z-aPos.z).toFixed(1)) : null;
      const lbl = dYStr ? `ΔY=${dYStr}" ΔZ=${dZStr}"` : `Y=${trial.y.toFixed(1)} Z=${trial.z.toFixed(1)}`;
      return <g><circle cx={tx} cy={ty} r={5} fill="#FCB830" opacity={0.9}/><line x1={tx-8} y1={ty} x2={tx+8} y2={ty} stroke="#FCB830" strokeWidth={1}/><line x1={tx} y1={ty-8} x2={tx} y2={ty+8} stroke="#FCB830" strokeWidth={1}/><text x={tx+8} y={ty-6} fill="#FCB830" fontSize={8}>{lbl}</text>
      {aPos&&(()=>{ const[ax,ay]=to(aPos.y,aPos.z); return <line x1={ax} y1={ay} x2={tx} y2={ty} stroke="#FCB830" strokeWidth={0.8} strokeDasharray="3,2" opacity={0.5}/>; })()}</g>; })()}
    {result&&(()=>{ const[cx,cy]=to(result.cgY,result.cgZ); return <g><line x1={cx-7} y1={cy} x2={cx+7} y2={cy} stroke="#CD2027" strokeWidth={1.5}/><line x1={cx} y1={cy-7} x2={cx} y2={cy+7} stroke="#CD2027" strokeWidth={1.5}/><circle cx={cx} cy={cy} r={5} fill="none" stroke="#CD2027" strokeWidth={1.5}/><text x={cx+8} y={cy-5} fill="#CD2027" fontSize={8} fontWeight="bold">CG</text></g>; })()}
    <text x={w/2} y={h-3} textAnchor="middle" fill="#4B4F54" fontSize={8}>Click to place selected component</text>
  </svg>;
}

// Single heatmap grid — renders one NxN grid with shared color scale, hover tooltip, crosshair angle.
function HeatMapGrid({ grid, steps, inc, globalMin, globalMax, title, currentVal, onHover }) {
  if (!grid?.length) return null;
  const cellW = 9, cellH = 8;
  const leftPad = 28, topPad = 14, bottomPad = 26, rightPad = 4;
  const svgW = steps * cellW + leftPad + rightPad;
  const svgH = steps * cellH + topPad + bottomPad;
  const half = Math.floor(steps / 2);
  const range = globalMax - globalMin || 1;

  const toColor = v => {
    if (v === null) return "#1A1A1A";
    const t = (v - globalMin) / range;
    return `hsl(${Math.round(t * 240)},80%,40%)`;
  };

  const cells = [];
  for (let ri = 0; ri < steps; ri++) {
    for (let ci = 0; ci < steps; ci++) {
      const v = grid[ri * steps + ci];
      const px = ci * cellW + leftPad;
      const py = ri * cellH + topPad;
      cells.push(
        <rect key={`${ri}-${ci}`} x={px} y={py} width={cellW} height={cellH} fill={toColor(v)}
          onMouseEnter={e => onHover({ x: e.clientX, y: e.clientY, val: v, dY: (ci - half) * inc, dZ: (half - ri) * inc })}
          onMouseLeave={() => onHover(null)} />
      );
    }
  }

  const cx = half * cellW + leftPad + cellW / 2;
  const cy2 = half * cellH + topPad + cellH / 2;

  const yLabels = [], zLabels = [];
  for (let i = 0; i <= steps; i += 5) {
    const dY = (i - half) * inc;
    yLabels.push(<text key={i} x={i * cellW + leftPad + cellW / 2} y={steps * cellH + topPad + 9} textAnchor="middle" fill="#808285" fontSize={6}>{dY >= 0 ? `+${dY.toFixed(1)}` : dY.toFixed(1)}</text>);
    const dZ = (half - i) * inc;
    zLabels.push(<text key={i} x={leftPad - 3} y={i * cellH + topPad + cellH / 2 + 2} textAnchor="end" fill="#808285" fontSize={6}>{dZ >= 0 ? `+${dZ.toFixed(1)}` : dZ.toFixed(1)}</text>);
  }

  const legendY = steps * cellH + topPad + 16;
  const legendW = steps * cellW;
  const legendStops = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    return <rect key={i} x={leftPad + legendW * t} y={legendY} width={legendW / 11 + 1} height={5} fill={`hsl(${Math.round(t * 240)},80%,40%)`} />;
  });

  return (
    <div className="flex flex-col items-start">
      <div className="text-[8px] font-bold uppercase tracking-wider mb-0.5" style={{ color: "#A7A9AC" }}>{title}</div>
      <svg viewBox={`0 0 ${svgW} ${svgH + 6}`} style={{ width: svgW * 1.5, maxWidth: "100%", height: "auto" }}>
        {cells}
        <line x1={cx - 5} y1={cy2} x2={cx + 5} y2={cy2} stroke="#fff" strokeWidth={1.5} />
        <line x1={cx} y1={cy2 - 5} x2={cx} y2={cy2 + 5} stroke="#fff" strokeWidth={1.5} />
        <circle cx={cx} cy={cy2} r={3} fill="none" stroke="#fff" strokeWidth={1} />
        {currentVal != null && <text x={cx + 5} y={cy2 - 5} fill="#fff" fontSize={6} fontWeight="bold">{currentVal.toFixed(1)}°</text>}
        {yLabels}
        {zLabels}
        <text x={steps * cellW / 2 + leftPad} y={legendY - 3} textAnchor="middle" fill="#4B4F54" fontSize={6}>ΔY (in.)</text>
        <text x={8} y={steps * cellH / 2 + topPad} textAnchor="middle" fill="#4B4F54" fontSize={6} transform={`rotate(-90,8,${steps * cellH / 2 + topPad})`}>ΔZ (in.)</text>
        {legendStops}
        <text x={leftPad} y={legendY + 12} fill="#808285" fontSize={6}>{globalMin.toFixed(1)}°</text>
        <text x={leftPad + legendW} y={legendY + 12} textAnchor="end" fill="#808285" fontSize={6}>{globalMax.toFixed(1)}°</text>
      </svg>
    </div>
  );
}

// Dual heatmap: Fwd Tip and Rear Tip side-by-side, shared color scale.
function DualHeatMap({ data, compName, result }) {
  const [hover, setHover] = useState(null);
  const { fwdGrid, rearGrid, steps, inc, fwdMin, fwdMax, rearMin, rearMax } = data;
  if (!fwdGrid?.length) return null;
  return (
    <div className="relative">
      <div className="text-[8px] text-[#A7A9AC] mb-1.5">
        <span className="font-bold text-white">{compName}</span> — Tip Angle vs Y/Z offset (in.) — independent scales per chart
      </div>
      <div className="flex gap-4 flex-nowrap overflow-x-auto">
        <HeatMapGrid grid={fwdGrid} steps={steps} inc={inc} globalMin={fwdMin} globalMax={fwdMax} title="Fwd Tip Angle" currentVal={result?.fwdTip ?? null} onHover={setHover} />
        <HeatMapGrid grid={rearGrid} steps={steps} inc={inc} globalMin={rearMin} globalMax={rearMax} title="Rear Tip Angle" currentVal={result?.rearTip ?? null} onHover={setHover} />
      </div>
      {hover && (
        <div className="fixed z-50 pointer-events-none px-2 py-1 rounded text-[10px] font-bold shadow-lg"
          style={{ left: hover.x + 12, top: hover.y - 8, backgroundColor: "#0D0D0D", border: "1px solid #FCB830", color: "#FCB830" }}>
          {hover.val !== null ? `${hover.val.toFixed(1)}°` : "—"}
          <span className="ml-1.5 text-[9px] font-normal text-[#A7A9AC]">ΔY={hover.dY >= 0 ? "+" : ""}{hover.dY.toFixed(1)}" ΔZ={hover.dZ >= 0 ? "+" : ""}{hover.dZ.toFixed(1)}"</span>
        </div>
      )}
    </div>
  );
}

function WBar({ d, lbl, cn }) {
  const { vals, labels } = d;
  if (!vals?.length) return null;
  const fl = vals.filter(v => v !== null); if (!fl.length) return null;
  const mn = Math.min(...fl), mx = Math.max(...fl), rng = mx - mn || 1, mid = Math.floor(vals.length / 2);
  const [hovIdx, setHovIdx] = React.useState(null);
  const barAreaH = 80;
  const labelRowH = 10;
  const deltaRowH = 10;
  return <div>
    {/* Delta row — shows Δ from current tip angle on hovered bar */}
    <div className="flex items-end gap-px" style={{ height: deltaRowH }}>
      {vals.map((v, i) => {
        if (v === null) return <div key={i} className="flex-1" />;
        const hov = i === hovIdx && i !== mid;
        if (!hov) return <div key={i} className="flex-1" />;
        const delta = v - vals[mid];
        const sign = delta >= 0 ? "+" : "";
        const color = delta >= 0 ? "#22C55E" : "#EF4444";
        return <div key={i} className="flex-1 text-center" style={{ fontSize: 6, fontWeight: "bold", color }}>{`${sign}${delta.toFixed(1)}°`}</div>;
      })}
    </div>
    {/* Angle labels row — fixed height above bars; show hovered value if active */}
    <div className="flex items-end gap-px" style={{ height: labelRowH }}>
      {vals.map((v, i) => {
        if (v === null) return <div key={i} className="flex-1" />;
        const cur = i === mid;
        const hov = i === hovIdx;
        const show = i % 3 === 0 || cur || hov;
        return <div key={i} className="flex-1 text-center" style={{ fontSize: 6, color: hov ? "#FCB830" : cur ? "#fff" : "#A7A9AC", fontWeight: hov ? "bold" : "normal" }}>
          {show ? v.toFixed(1) + "°" : ""}
        </div>;
      })}
    </div>
    {/* Bars row — all flush to bottom */}
    <div className="flex items-end gap-px" style={{ height: barAreaH }}>
      {vals.map((v, i) => {
        if (v === null) return <div key={i} className="flex-1" />;
        const ht = Math.max(4, ((v - mn) / rng) * (barAreaH - 10) + 10);
        const cur = i === mid;
        const hov = i === hovIdx;
        return <div key={i} className="flex-1 relative overflow-hidden" style={{ height: ht, backgroundColor: cur ? "#CD2027" : hov ? "#6B7280" : "#4B4F54", borderRadius: 1, border: cur ? "1.5px solid #A7A9AC" : hov ? "1px solid #A7A9AC" : "none", flexShrink: 0, cursor: "default" }}
          onMouseEnter={() => setHovIdx(i)} onMouseLeave={() => setHovIdx(null)}>
          {cur && ht >= 20 && (
            <span style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%) rotate(-90deg)", fontSize: 6, fontWeight: "bold", color: "#fff", whiteSpace: "nowrap", letterSpacing: 1, opacity: 0.85 }}>
              CURRENT
            </span>
          )}
        </div>;
      })}
    </div>
    {/* Weight labels row — show hovered value if active */}
    <div className="flex gap-px mt-0.5">
      {vals.map((v, i) => {
        if (v === null) return <div key={i} className="flex-1" />;
        const cur = i === mid;
        const hov = i === hovIdx;
        const showLbl = cur || hov || i % 4 === 0;
        return <div key={i} className="flex-1 text-center" style={{ fontSize: 6, color: hov ? "#FCB830" : cur ? "#fff" : "#808285", fontWeight: cur || hov ? "bold" : "normal" }}>
          {hov ? `${labels[i]?.toFixed(0)} lbs` : cur ? `${labels[i]?.toFixed(0)} lbs` : (i % 4 === 0 ? labels[i]?.toFixed(0) : "")}
        </div>;
      })}
    </div>
    <div className="text-[7px] text-[#A7A9AC] text-center mt-0.5">{cn} weight (lbs) — {lbl}</div>
  </div>;
}