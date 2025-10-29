import * as THREE from "three";
import { MindARThree } from "mindar-face-three";

const mindarThree = new MindARThree({
  container: document.getElementById("face-scan-container"),
  uiLoading: false,
  uiScanning: false,
  uiError: false,
});

const { renderer, scene, camera } = mindarThree;

// Create face mesh with custom scanning effect material
const faceMesh = mindarThree.addFaceMesh();
const texture = new THREE.TextureLoader().load("/assets/images/face-mesh.png");

// Shader uniforms
const uniforms = {
  map: {
    value: texture,
  },
  time: {
    value: 0,
  },
  lineColor: {
    value: new THREE.Color(0xffffff),
  },
  lineSpeed: {
    value: 1.0,
  },
  lineWidth: {
    value: 0.01,
  },
  glowWidth: {
    value: 0.02,
  },
};

// Declare the variables before using them
// let base64Center; // hasil dari file upload / webcam
// let base64Left;
// let base64Right;

// const images = {
//   center: base64Center,
//   left: base64Left,
//   right: base64Right,
// };

// document.addEventListener('DOMContentLoaded', () => {
//       document.getElementById("scan-btn").addEventListener("click", async () => {
//         console.log("📸 Sending images to backend...");
//         const result = await loadPrediction(images);
//         console.log("✅ Backend response received!", result);
//       });
//     });

// -------------------- CONFIG (updated) --------------------
const FACE_SHAPE_CONFIG = {
  emaAlpha: 0.18, // smoothing (0 = no smoothing, closer to 1 = slower updates)
  sigma: 0.08, // scoring sensitivity (smaller = more sensitive)
  lowerSlice: [0.0, 0.33],
  middleSlice: [0.33, 0.66],
  upperSlice: [0.66, 1.0],
  minConfidence: 0.03, // never report lower than this (3%)
  softmaxEps: 1e-6, // tiny regularizer for numerical stability
  lastResultDecay: 0.6, // multiply previous confidence by this when measurements fail
  shapes: {
    Oval: {
      ideal: [1.5, 0.8, 1.02],
      weight: [0.5, 0.25, 0.25],
    }, // less jaw weight
    Round: {
      ideal: [1.18, 0.98, 1.0],
      weight: [0.45, 0.3, 0.25],
    },
    Square: {
      ideal: [1.2, 1.05, 1.0],
      weight: [0.3, 0.55, 0.15],
    }, // stronger jaw weight, jaw ideal > 1
    Rectangle: {
      ideal: [1.6, 0.93, 1.0],
      weight: [0.5, 0.25, 0.25],
    },
    Heart: {
      ideal: [1.35, 0.8, 1.2],
      weight: [0.35, 0.25, 0.4],
    },
    Diamond: {
      ideal: [1.45, 0.78, 0.92],
      weight: [0.45, 0.25, 0.3],
    },
    Triangle: {
      ideal: [1.25, 1.1, 0.88],
      weight: [0.35, 0.4, 0.25],
    },
  },
};

// -------------------- STATE --------------------
const faceShapeState = {
  ema: null, // EMA for numeric measurements
  lastResult: null, // last returned detection result (for graceful fallback)
};

let faceShapeResult =
  typeof faceShape !== "undefined" && faceShape.length
    ? faceShape[0]
    : {
        name: "Unknown",
      };

// -------------------- HELPERS --------------------
function isValidNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && !Number.isNaN(v);
}

function clamp(v, a = 0, b = 1) {
  return Math.max(a, Math.min(b, v));
}

function ema(prev, next, alpha) {
  if (!prev)
    return {
      ...next,
    };
  const out = {};
  for (const k of Object.keys(next)) {
    const nv = next[k];
    if (isValidNumber(nv) && isValidNumber(prev[k]))
      out[k] = alpha * nv + (1 - alpha) * prev[k];
    else if (isValidNumber(nv)) out[k] = nv;
    else out[k] = prev[k] ?? 0;
  }
  return out;
}

// -------------------- HELPERS (updated to transform -> NDC/screen) --------------------
function buildPoints(positions, mesh = null, camera = null) {
  // positions is Float32Array [x,y,z,...]
  // If mesh and camera provided, points will be projected to NDC via camera
  // If mesh provided but camera omitted, points will be converted to world-space (3D)
  const pts = [];
  const v = new THREE.Vector3();

  // cache matrixWorld for speed if provided
  const mat = mesh && mesh.matrixWorld ? mesh.matrixWorld : null;

  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]);

    if (mat) {
      v.applyMatrix4(mat); // now in world-space
    }

    if (camera) {
      // project to NDC (-1..1)
      v.project(camera);
      // use NDC x/y for relative geometry. z remains depth (optional)
      pts.push({
        x: v.x,
        y: v.y,
        z: v.z,
      });
    } else {
      // world-space fallback (3D)
      pts.push({
        x: v.x,
        y: v.y,
        z: v.z,
      });
    }
  }
  return pts;
}

function computeBBox(points) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const width = maxX - minX || 1e-6;
  const height = maxY - minY || 1e-6;
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
  };
}

function sliceWidth(points, bbox, fracStart, fracEnd) {
  const yStart = bbox.minY + fracStart * bbox.height;
  const yEnd = bbox.minY + fracEnd * bbox.height;

  let left = Infinity,
    right = -Infinity,
    count = 0;
  for (const p of points) {
    if (p.y >= yStart && p.y <= yEnd) {
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      count++;
    }
  }
  if (count === 0) return bbox.width || 1e-6;
  return Math.max(1e-6, right - left);
}

function getFaceMeasurementsFromMesh(positions, mesh = null, camera = null) {
  // positions: Float32Array
  // mesh: the THREE.Mesh (faceMesh) so we can transform to world and project to camera
  // camera: optional THREE.Camera to project into 2D NDC space (recommended)
  const points = buildPoints(positions, mesh, camera);

  // If using NDC coordinates (camera provided), note NDC y runs -1..1,
  // but relative bbox calculations still work fine.
  const bbox = computeBBox(points);

  const jaw = sliceWidth(points, bbox, ...FACE_SHAPE_CONFIG.lowerSlice);
  const cheekbone = sliceWidth(points, bbox, ...FACE_SHAPE_CONFIG.middleSlice);
  const forehead = sliceWidth(points, bbox, ...FACE_SHAPE_CONFIG.upperSlice);
  const length = bbox.height;

  return {
    jaw,
    cheekbone,
    forehead,
    length,
    bbox,
  };
}

// -------------------- SCORING (stable + non-zero confidences) --------------------
function gaussianScore(measured, ideal, sigma) {
  if (
    !isValidNumber(measured) ||
    !isValidNumber(ideal) ||
    ideal === 0 ||
    !(sigma > 0)
  )
    return 0;
  const diff = (measured - ideal) / ideal;
  const val = Math.exp((-0.5 * (diff * diff)) / (sigma * sigma));
  return isValidNumber(val) ? val : 0;
}

function scoreShapes(meas) {
  const { jaw, cheekbone, forehead, length } = meas;

  // quick guard: if critical dims invalid -> attempt to return lastResult or uniform small confidences
  if (
    !isValidNumber(cheekbone) ||
    cheekbone <= 1e-6 ||
    !isValidNumber(length)
  ) {
    // If we have a lastResult, return it (but we'll handle decay in detect function)
    if (faceShapeState.lastResult) {
      const fallback = Object.keys(FACE_SHAPE_CONFIG.shapes).map((name) => ({
        name,
        score: faceShapeState.lastResult.name === name ? 1 : 0,
        confidence:
          faceShapeState.lastResult.name === name
            ? faceShapeState.lastResult.confidence
            : 0,
        details: {},
        ratios: {},
      }));
      return fallback;
    }
    // Otherwise produce tiny uniform confidences
    const n = Object.keys(FACE_SHAPE_CONFIG.shapes).length;
    const conf = 1 / n;
    return Object.keys(FACE_SHAPE_CONFIG.shapes).map((name) => ({
      name,
      score: 0,
      confidence: conf,
      details: {},
      ratios: {},
    }));
  }

  const lengthToWidth = length / cheekbone;
  const jawToCheek = jaw / cheekbone;
  const foreheadToCheek = forehead / cheekbone;
  const ratios = {
    lengthToWidth,
    jawToCheek,
    foreheadToCheek,
  };

  const results = [];
  for (const [name, meta] of Object.entries(FACE_SHAPE_CONFIG.shapes)) {
    const [idealLtoW, idealJtoC, idealFtoC] = meta.ideal;
    const w = meta.weight;

    const sL = gaussianScore(lengthToWidth, idealLtoW, FACE_SHAPE_CONFIG.sigma);
    const sJ = gaussianScore(jawToCheek, idealJtoC, FACE_SHAPE_CONFIG.sigma);
    const sF = gaussianScore(
      foreheadToCheek,
      idealFtoC,
      FACE_SHAPE_CONFIG.sigma
    );

    const score = sL * w[0] + sJ * w[1] + sF * w[2];
    results.push({
      name,
      score,
      details: {
        sL,
        sJ,
        sF,
      },
      ratios,
    });
  }

  // Softmax with tiny regularizer to avoid all-zero or NaN
  const scores = results.map((r) => r.score);
  const maxScore = Math.max(...scores, 0);
  const exps = results.map((r) => {
    const capped = clamp(r.score - maxScore, -50, 50);
    const v = Math.exp(capped);
    return isFinite(v)
      ? v + FACE_SHAPE_CONFIG.softmaxEps
      : FACE_SHAPE_CONFIG.softmaxEps;
  });
  let sumExp = exps.reduce((a, b) => a + b, 0) || 1;

  // initial confidences
  results.forEach((r, i) => (r.confidence = clamp(exps[i] / sumExp, 0, 1)));

  // enforce minimum confidence floor and renormalize
  const minC = FACE_SHAPE_CONFIG.minConfidence;
  let needRenorm = false;
  for (const r of results) {
    if (r.confidence < minC) {
      r.confidence = minC;
      needRenorm = true;
    }
  }
  if (needRenorm) {
    const tot = results.reduce((s, r) => s + r.confidence, 0) || 1;
    results.forEach((r) => (r.confidence = clamp(r.confidence / tot, 0, 1)));
  }

  results.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  return results;
}

// -------------------- DETECTION ENTRY (updated signature) --------------------
function detectFaceShapeFromMesh(positions, mesh = null, camera = null) {
  // Validate positions quickly and allow graceful fallback to lastResult
  if (!positions || positions.length < 12) {
    if (faceShapeState.lastResult) {
      const dec = clamp(
        (faceShapeState.lastResult.confidence || 0) *
          FACE_SHAPE_CONFIG.lastResultDecay,
        FACE_SHAPE_CONFIG.minConfidence,
        1
      );
      return {
        ...faceShapeState.lastResult,
        confidence: dec,
      };
    }
    return {
      name: "Oval",
      confidence: FACE_SHAPE_CONFIG.minConfidence,
      score: 0,
      second: null,
      measurements: {
        jaw: 0,
        cheekbone: 0,
        forehead: 0,
        length: 0,
      },
      ratios: {
        lengthToWidth: 0,
        jawToCheek: 0,
        foreheadToCheek: 0,
      },
    };
  }

  const raw = getFaceMeasurementsFromMesh(positions, mesh, camera);
  const numericRaw = {
    jaw: raw.jaw,
    cheekbone: raw.cheekbone,
    forehead: raw.forehead,
    length: raw.length,
  };

  if (!isValidNumber(numericRaw.cheekbone) || numericRaw.cheekbone <= 1e-6) {
    if (faceShapeState.lastResult) {
      const dec = clamp(
        (faceShapeState.lastResult.confidence || 0) *
          FACE_SHAPE_CONFIG.lastResultDecay,
        FACE_SHAPE_CONFIG.minConfidence,
        1
      );
      return {
        ...faceShapeState.lastResult,
        confidence: dec,
      };
    } else {
      return {
        name: "Oval",
        confidence: FACE_SHAPE_CONFIG.minConfidence,
        score: 0,
        second: null,
        measurements: numericRaw,
        ratios: {
          lengthToWidth: 0,
          jawToCheek: 0,
          foreheadToCheek: 0,
        },
      };
    }
  }

  // apply EMA to numeric measurements only
  faceShapeState.ema = ema(
    faceShapeState.ema,
    numericRaw,
    FACE_SHAPE_CONFIG.emaAlpha
  );

  const scored = scoreShapes(faceShapeState.ema);
  const top = scored[0] || {
    name: "Oval",
    confidence: FACE_SHAPE_CONFIG.minConfidence,
    score: 0,
  };
  const second = scored[1] || null;

  const conf = isValidNumber(top.confidence)
    ? clamp(top.confidence, FACE_SHAPE_CONFIG.minConfidence, 1)
    : FACE_SHAPE_CONFIG.minConfidence;

  const result = {
    name: top.name,
    confidence: conf,
    score: isValidNumber(top.score) ? top.score : 0,
    second: second
      ? {
          name: second.name,
          confidence: isValidNumber(second.confidence)
            ? clamp(second.confidence, FACE_SHAPE_CONFIG.minConfidence, 1)
            : FACE_SHAPE_CONFIG.minConfidence,
        }
      : null,
    measurements: {
      ...faceShapeState.ema,
    },
    ratios: top.ratios || {
      lengthToWidth: 0,
      jawToCheek: 0,
      foreheadToCheek: 0,
    },
  };

  // persist lastResult for fallback use
  faceShapeState.lastResult = {
    name: result.name,
    confidence: result.confidence,
    score: result.score,
    measurements: result.measurements,
    ratios: result.ratios,
  };

  return result;
}

// -------------------- INTEGRATION: call in your update loop (updated) --------------------
function onUpdate() {
  if (typeof faceMesh === "undefined" || !faceMesh || !faceMesh.geometry)
    return;
  const positions = faceMesh.geometry.attributes.position.array;

  // IMPORTANT: pass faceMesh and your THREE.Camera instance (replace 'camera' with your camera variable)
  // This makes measurements operate in camera-projected 2D space (NDC) where face shape is visually meaningful.
  const detection = detectFaceShapeFromMesh(positions, faceMesh, camera);

  const found =
    typeof faceShape !== "undefined"
      ? faceShape.find((item) => item.name === detection.name)
      : null;
  faceShapeResult = found
    ? {
        ...found,
        confidence: detection.confidence,
      }
    : {
        name: detection.name,
        confidence: detection.confidence,
      };

  faceShapeResult._debug = {
    confidence: detection.confidence,
    second: detection.second,
    measurements: detection.measurements,
    ratios: detection.ratios,
  };
}

// -------------------- LOGGER (safe) --------------------
function logFaceShape() {
  if (!faceShapeResult) return;
  const conf = isValidNumber(faceShapeResult.confidence)
    ? faceShapeResult.confidence
    : FACE_SHAPE_CONFIG.minConfidence;
  console.log(
    `Detected: ${faceShapeResult.name} (${(conf * 100).toFixed(0)}%)`,
    faceShapeResult._debug || {}
  );
}

// Vertex shader remains the same
const vertexShader = `
`;

// Updated fragment shader with more solid scanning line
const fragmentShader = `
`;

// Create custom shader material
const material = new THREE.ShaderMaterial({
  uniforms: uniforms,
  vertexShader: vertexShader,
  fragmentShader: fragmentShader,
  transparent: true,
});

faceMesh.material = material;
scene.add(faceMesh);

let lookedRight = false,
  lookedLeft = false,
  lookedStraight = false;
let currentStepIndex = 0;
let startCapture = false;
let startScanFace = false;
let clock;

const scanSteps = [
  {
    text: "Please look forward",
    orientation: "straight",
  },
  {
    text: "Please look right",
    orientation: "right",
  },
  {
    text: "Please look left",
    orientation: "left",
  },
];

let timeOutScan;

function captureFrame(orientation) {
  const video = document.querySelector("#face-scan-container > video");
  if (!video) return null;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");

  // Flip horizontally for mirror effect
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  return {
    orientation: orientation,
    dataUrl: canvas.toDataURL("image/png"),
  };
}

function nextStep() {
  currentStepIndex++;
  if (currentStepIndex < scanSteps.length) {
    $("#scan-helper-text").text(scanSteps[currentStepIndex].text);

    // Calculate progress percentage based on completed steps
    const progressPercentage = currentStepIndex * (100 / scanSteps.length);
    $("#scan-progress").css("width", `${progressPercentage}%`);
  }
}

// Helper function to find image data by detection type
function findImageByDetectionType(dataArrays, detectionType) {
  for (const dataArray of dataArrays) {
    for (const item of dataArray) {
      if (item.id === detectionType) {
        return item;
      }
    }
  }
  return null;
}

// ui.js
// Prevent page reload on unhandled promise rejection
// window.addEventListener("unhandledrejection", function (event) {
//   console.error("Unhandled rejection:", event.reason);
//   event.preventDefault();
// });

let scanCompleted = false;

// async function startFaceScan() {
//   try {
//     await mindarThree.start();
//     if (camera && camera.isPerspectiveCamera) {
//       camera.zoom = 1.0;
//       camera.updateProjectionMatrix();
//       console.log("Camera zoom diatur menjadi:", camera.zoom);
//     }

//     clock = new THREE.Clock();

//     renderer.setAnimationLoop(() => {
//       // Update face detection
//       if (startScanFace) {
//         onUpdate(); // your existing face detection update function
//       }

//       // === FACE SCANNING FLOW ===
//       if (startCapture && currentStepIndex < scanSteps.length) {
//         const currentStep = scanSteps[currentStepIndex];

//         // === Head orientation values from MediaPipe / MindAR tracking ===
//         const yaw = window.eulerY;   // left/right
//         const pitch = window.eulerX; // up/down
//         const roll = window.eulerZ;  // tilt

//         // ======= HEAD POSITION VALIDATION =======
//         // Restrict UP/DOWN
//         if (Math.abs(pitch) > 0.25) {
//           console.warn("❌ Head up/down detected – please keep your face level.");
//           $("#scan-status")
//             .text("❌ Please keep your head straight (no up/down).")
//             .css("color", "red");
//           return;
//         }

//         // Restrict SIDE TILT
//         if (Math.abs(roll) > 0.2) {
//           console.warn("❌ Head tilted sideways.");
//           $("#scan-status")
//             .text("❌ Please avoid tilting your head sideways.")
//             .css("color", "red");
//           return;
//         }

//         // ======= ORIENTATION CHECK =======
//         if (currentStep.orientation === "straight" && Math.abs(yaw) < 0.15 && !lookedStraight) {
//           const capture = captureFrame("straight");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedStraight = true;
//             $("#scan-status").text("✅ Frontal captured").css("color", "lime");
//             setTimeout(() => nextStep(), 2000);
//           }
//         } 
//         else if (currentStep.orientation === "right" && yaw > 0.45 && !lookedRight) {
//           const capture = captureFrame("right");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedRight = true;
//             $("#scan-status").text("➡️ Right face captured").css("color", "gold");
//             nextStep();
//           }
//         } 
//         else if (currentStep.orientation === "left" && yaw < -0.45 && !lookedLeft) {
//           const capture = captureFrame("left");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedLeft = true;
//             $("#scan-status").text("⬅️ Left face captured").css("color", "gold");
//             nextStep();
//           }
//         }

//         // ======= COMPLETION CHECK =======
//         if (lookedStraight && lookedLeft && lookedRight && !scanCompleted) {
//           scanCompleted = true;
//           $("#scan-status").text("✅ Face scanning completed!").css("color", "lime");
//           completeScan();
//         }
//       }

//       // === Face mesh animation update ===
//       if (faceMesh?.material) {
//         faceMesh.material.uniforms.time.value = clock.getElapsedTime();
//       }

//       renderer.render(scene, camera);
//     });

//     // === UI Initialization ===
//     $("#splash-screen").css("pointer-events", "all");
//     $(".splash-continue > span").text("[ tap to continue ]");
//     $(".splash-continue > .fas").css("display", "none");
//     $(".splash-continue").css("pointer-events", "all");
//     $(".splash-loading").fadeOut(300);
//     $(".button-start-wrapper").removeClass("d-none");
//     $("#button-scan-qr").removeClass("d-none");
//     $("#button-fill-form").removeClass("d-none");
//     $("#instruct-home").removeClass("d-none");

//   } catch (error) {
//     console.error("Face scan initialization failed:", error);
//     $(".splash-loading")
//       .html("<small>Error starting camera,<br/>Please allow camera access.</small>")
//       .addClass("text-danger text-center");
//   }
// }

async function applyHardwareZoom(mediaStream, zoomValue) {
  if (!mediaStream) return false;
  const [videoTrack] = mediaStream.getVideoTracks();
  if (!videoTrack) return false;
  const capabilities = videoTrack.getCapabilities();
  if (!('zoom' in capabilities)) {
    console.log(":warning: Hardware zoom not supported.");
    return false;
  }
  const minZoom = capabilities.zoom.min;
  const maxZoom = capabilities.zoom.max;
  const clampedZoom = Math.min(Math.max(zoomValue, minZoom), maxZoom);
  try {
    await videoTrack.applyConstraints({ advanced: [{ zoom: clampedZoom }] });
    console.log(`:white_check_mark: Hardware zoom applied: ${clampedZoom}`);
    return true;
  } catch (err) {
    console.warn(":warning: Failed to apply hardware zoom:", err);
    return false;
  }
}
// === Main: startFaceScan ===
async function startFaceScan() {
  try {
    // Start camera (MindAR)
    await mindarThree.start();
    // Ambil stream video dari MindAR
    const mediaStream = mindarThree.video?.srcObject || null;
    // === AUTO ZOOM: apply hardware zoom if available ===
    const desiredZoom = 2.0;
    const hardwareZoomApplied = await applyHardwareZoom(mediaStream, desiredZoom);
    // === FALLBACK: pakai zoom Three.js kalau hardware tidak mendukung ===
    if (!hardwareZoomApplied && camera?.isPerspectiveCamera) {
      camera.zoom = desiredZoom;
      camera.updateProjectionMatrix();
      console.log(":wrench: Software zoom (Three.js) set to:", camera.zoom);
    }
    // === Start clock dan animation loop ===
    clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      if (startScanFace) onUpdate();
      if (startCapture && currentStepIndex < scanSteps.length) {
        const currentStep = scanSteps[currentStepIndex];
        // === Capture orientation ===
        if (
          currentStep.orientation === "straight" &&
          Math.abs(window.eulerY) < 0.2 &&
          !lookedStraight
        ) {
          const capture = captureFrame("straight");
          if (capture) {
            capturedImages.push(capture);
            lookedStraight = true;
            setTimeout(() => nextStep(), 1500);
          }
        } else if (
          currentStep.orientation === "right" &&
          window.eulerY > 0.48 &&
          !lookedRight
        ) {
          const capture = captureFrame("right");
          if (capture) {
            capturedImages.push(capture);
            lookedRight = true;
            setTimeout(() => nextStep(), 1500);
          }
        } else if (
          currentStep.orientation === "left" &&
          window.eulerY < -0.48 &&
          !lookedLeft
        ) {
          const capture = captureFrame("left");
          if (capture) {
            capturedImages.push(capture);
            lookedLeft = true;
            setTimeout(() => nextStep(), 1500);
          }
        }
        // === Complete Scan ===
        if (lookedStraight && lookedLeft && lookedRight && !scanCompleted) {
          scanCompleted = true;
          completeScan();
        }
      }
      // === Animate face mesh ===
      if (faceMesh?.material) {
        faceMesh.material.uniforms.time.value = clock.getElapsedTime();
      }
      renderer.render(scene, camera);
    });
    // Initialize UI
    $("#splash-screen").css("pointer-events", "all");
    $(".splash-continue > span").text("[ tap to continue ]");
    $(".splash-continue > .fas").css("display", "none");
    $(".splash-continue").css("pointer-events", "all");
    $(".splash-loading").fadeOut(300);
    $(".button-start-wrapper").removeClass("d-none");
    // $("#button-start").removeClass("d-none");
    $("#button-scan-qr").removeClass("d-none");
    $("#button-fill-form").removeClass("d-none");
    $("#instruct-home").removeClass("d-none");
  } catch (error) {
    console.error("Face scan initialization failed:", error);
    $(".splash-loading")
      .html(
        "<small>Error starting camera,<br/>Please allow camera access.</small>"
      )
      .addClass("text-danger text-center");
  }
}

// async function startFaceScan() {
//   try {
//     await mindarThree.start();
//     if (camera && camera.isPerspectiveCamera) {
//       camera.zoom = 2.0; // Ubah dari 0.5 menjadi 1
//       camera.updateProjectionMatrix();
//       console.log("Camera zoom diatur menjadi:", camera.zoom);
//     }
                        
//     clock = new THREE.Clock();

//     renderer.setAnimationLoop(() => {
//       // Update face detection
//       if (startScanFace) {
//         onUpdate(); // Your existing face detection update function
//       }

//       // Scanning logic
//       if (startCapture && currentStepIndex < scanSteps.length) {
//         const currentStep = scanSteps[currentStepIndex];

//         if (
//           currentStep.orientation === "straight" &&
//           Math.abs(window.eulerY) < 0.2 &&
//           !lookedStraight
//         ) {
//           const capture = captureFrame("straight");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedStraight = true;
//             setTimeout(() => {
//               nextStep();
//             }, 2000);
//           }
//         } else if (
//           console.log(window.eulerY),
//           currentStep.orientation === "right" &&
//           window.eulerY > 0.48 &&
//           !lookedRight
//         ) {
//           const capture = captureFrame("right");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedRight = true;
//             nextStep();
//           }
//         } else if (
//           console.log(window.eulerY),
//           currentStep.orientation === "left" &&
//           window.eulerY < -0.48 &&
//           !lookedLeft
//         ) {
//           const capture = captureFrame("left");
//           if (capture) {
//             capturedImages.push(capture);
//             lookedLeft = true;
//             nextStep();
//           }
//         }

//         // // Check for completion
//         // const straightImage = capturedImages.find(
//         //   (img) => img.orientation === "straight"
//         // );
//         // const leftImage = capturedImages.find(
//         //   (img) => img.orientation === "left"
//         // );
//         // const rightImage = capturedImages.find(
//         //   (img) => img.orientation === "right"
//         // );

//         // if (straightImage)
//         //   $("<img>")
//         //     .addClass("straight-face")
//         //     .attr("src", straightImage.dataUrl)
//         //     .appendTo("#captured-photo");
//         // if (leftImage)
//         //   $("<img>")
//         //     .addClass("left-face")
//         //     .attr("src", leftImage.dataUrl)
//         //     .appendTo("#captured-photo");
//         // if (rightImage)
//         //   $("<img>")
//         //     .addClass("right-face")
//         //     .attr("src", rightImage.dataUrl)
//         //     .appendTo("#captured-photo");

//         // const straightFaceSrc = straightImage?.dataUrl?.split(",")[1];
//         // const leftFaceSrc = leftImage?.dataUrl?.split(",")[1];
//         // const rightFaceSrc = rightImage?.dataUrl?.split(",")[1];

//         // if (straightFaceSrc && leftFaceSrc && rightFaceSrc) {
//         //   if (window.location.pathname === "/hair") {
//         //     postData.id = "123";
//         //     postData.sources.push(straightFaceSrc);
//         //     postData.sources.push(leftFaceSrc);
//         //     postData.sources.push(rightFaceSrc);
//         //     // postData.raw_landmarks.push('')
//         //     // completeScanSkin();
//         //     completeScan();
//         //   }
//         // }

//         if (lookedStraight && lookedLeft && lookedRight && !scanCompleted) {
//           scanCompleted = true; // prevent repeated calls
//           completeScan();
//         }
//       }

//       // Update face mesh animation
//       if (faceMesh?.material) {
//         faceMesh.material.uniforms.time.value = clock.getElapsedTime();
//       }

//       renderer.render(scene, camera);
//     });

//     // Initialize UI
//     $("#splash-screen").css("pointer-events", "all");
//     $(".splash-continue > span").text("[ tap to continue ]");
//     $(".splash-continue > .fas").css("display", "none");
//     $(".splash-continue").css("pointer-events", "all");

//     $(".splash-loading").fadeOut(300);
//     $(".button-start-wrapper").removeClass("d-none");
//     // $("#button-start").removeClass("d-none");
//     $("#button-scan-qr").removeClass("d-none");
//     $("#button-fill-form").removeClass("d-none");
//     $("#instruct-home").removeClass("d-none");
//   } catch (error) {
//     console.error("Face scan initialization failed:", error);
//     $(".splash-loading")
//       .html(
//         "<small>Error starting camera,<br/>Please allow camera access.</small>"
//       )
//       .addClass("text-danger text-center");
//   }
// }

startFaceScan();

// Scan button handler
$("#scan-btn").on("click", function (e) {
  e.preventDefault(); // ← Add this
  e.stopPropagation(); // ← Add this

  $(".scanner-line").removeClass("d-none")

  $(this).css("pointer-events", "none");
  $("#scan-btn").html(
    '<i class="fas fa-spinner fa-spin me-2"></i> Scanning...'
  );

  // Reset state
  lookedRight = lookedLeft = lookedStraight = false;
  currentStepIndex = 0;

  // Setup UI
  $("#face-scan-container").addClass("scanning");
  $(".scan-animation").fadeIn(300);

  // Set initial text and progress
  $("#scan-helper-text").text("");
  $("#scan-progress").css("width", "0%"); // Start at 0%

  // Capture initial straight frame
  const straightCapture = captureFrame("straight");
  if (straightCapture) {
    capturedImages.push(straightCapture);
    lookedStraight = true;

    // Update preview
    $(".captured-left img").attr("src", straightCapture.dataUrl);

    // Move to next step and update progress to 33.3%
    nextStep();
  }

  startCapture = true;
});

// Button event handlers
$("#qr-profile-btn").click(() => showScreen("startScan"));
$("#splash-screen").click(() => showScreen("landing"));

// $("#start-btn").click(() => {
//   startScanFace = true;
//   showScreen("scan");
// });

// $("#result-continue-btn").click(() => {
//   showScreen("hairstyle");
// });
$("#hairstyle-continue-btn").click(() => showScreen("product"));
$("#restart-btn").click(() => showScreen("landing"));

// $('.hairstyle-grid-inner').owlCarousel({
//   loop: false,
//   margin: 10,
//   nav: false,
//   // center: true,
//   dots: false,
//   // navText: ["<div class='tab-arrow prev icon-white'><img src='/assets/images/arrow-slider.png'></div>", "<div class='tab-arrow next icon-white'><img src='/assets/images/arrow-slider.png'></div>"],
//   responsive: {
//     0: {
//       items: 5,
//       margin: 20,
//       nav: false
//     },
//     1000: {
//       items: 5,
//       margin: 20,
//       nav: false
//     }
//   }
// });

// const regexEmail = (email) => {
//   return /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
//     email
//   );
// };

// const regexPhone = (phone) => {
//   return /^0[1-9][0-9]{7,11}$/.test(phone);
// };

// let nameValid = false,
//   phoneValid = false,
//   tncValid = false,
//   tnc2Valid = true;
// $("#form input")
//   .on("keyup keydown change", function () {
//     // Check validity for name field
//     if ($(this).hasClass("name")) {
//       if ($(".name").val().trim() === "") {
//         $(".name").next(".error-validation").fadeIn(300);
//         nameValid = false;
//       } else {
//         $(".name").next(".error-validation").fadeOut(300); // Hide error if valid
//         nameValid = true;
//       }
//     }

//     // Check validity for phone field
//     if ($(this).hasClass("phone")) {
//       let phoneValue = $(this).val().trim();

//       const $error = $(this)
//         .closest(".input-wrapper")
//         .find(".error-validation");

//       if (phoneValue === "" || !regexPhone(phoneValue)) {
//         $error.fadeIn(300);
//         phoneValid = false;
//       } else {
//         $error.fadeOut(300);
//         phoneValid = true;
//       }
//     }

//     // Check validity for phone field
//     if ($(this).hasClass("tnc")) {
//       if ($(".tnc").prop("checked", true)) {
//         tncValid = true;
//       }
//     }

//     // Check validity for phone field
//     if ($(this).hasClass("tnc2")) {
//       if ($(".tnc2").prop("checked", true)) {
//         tnc2Valid = true;
//       }
//     }

//     // Toggle the submit button state
//     if (nameValid && phoneValid && tncValid && tnc2Valid) {
//       $("#submit-form").removeClass("disabled");
//     } else {
//       $("#submit-form").addClass("disabled");
//     }
//   })
//   .on("blur", function () {
//     $(".input-autocomplete").slideUp(300);
//   });

$("#product-hair-screen .icon-back").on("click", function () {
  $(".owl-item:first-child .hairstyle-item").click();
  showScreen("hairstyle");
});

// $("#button-to-hairstyle").on("click", function () {
//   showScreen("hairstyle");
// });

$("#hairstyle-list-screen .icon-back").on("click", function () {
  showScreen("hairstyle");
});

// $("#loading-screen .icon-back").on("click", function () {
//   showScreen("scanHair");
// });

$("#button-style-vault").on("click", function () {
  showScreen("hairstyleList")
});

$("#home-page-hair .icon-back").on("click", function () {
  window.location.reload();
});

$("#page-question-hair .icon-back").on("click", function () {
  window.location.reload();
})


$("#face-scan-hair .icon-back").on("click", function () {
  window.location.reload();
});

// $("#hair-analyzer-splash .icon-back").on("click", function () {
//   window.location.reload();
// });

$("#hairstyle-screen .icon-back").on("click", function () {
  window.location.reload();
});

window.applyHeadTexture = function (model, texturePath) {
  const textureLoader = new THREE.TextureLoader();
  const uvTexture = textureLoader.load(
    texturePath,
    () => {
      console.log(":white_check_mark: Texture loaded successfully");
      uvTexture.flipY = false;
      uvTexture.needsUpdate = true;
    },
    undefined,
    (err) => {
      console.error(":x: Error loading texture:", err);
    }
  );

  model.traverse((child) => {
    if (child.isMesh && child.name === "MaleHead") {
      console.log(`:dart: Applying texture to: ${child.name}`);
      child.material = new THREE.MeshBasicMaterial({
        map: uvTexture,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
      });
    }
  });
};

$(".selection-wrap").each(function () {
  var This = $(this);
  $(this)
    .find(".selection-item")
    .on("click", function () {
      This.find(".selection-item").removeClass("selected");
      if (This.find(".selection-item input").is(":checked")) {
        $(this).addClass("selected");
      }

      setTimeout(function () {
        if ($(".selection-item input:checked").length === 3) {
          console.log($(".selection-item input:checked").length);
          $(".next-to-form").removeClass("disabled");
        }
      }, 0);
    });
});

$(".splash-agreement input").on("change", function () {
  if ($(this).is(":checked")) {
    $("#take-selfie").removeClass("disabled");
  }
});

$("#button-start").on("click", function () {
  if (window.location.pathname === "/hair") {
    showScreen("scanHairAnalyzer");
  } else {
    showScreen("pageIntro");
  }
});

$("#page-intro .icon-back").on("click", function () {
  showScreen("homePage");
});

$("#hair-analyzer-splash .icon-back").on("click", function () {
  showScreen("registForm");
});

$("#skip-selfie").on("click", function () {
  showScreen("scanAnalyzerSelection");
});

$(".button-to-form").on("click", function () {
  showScreen("pageForm");
});

$("#next-to-result").on("click", function () {
  showScreen("pageSkinProduct");
});

$("#button-fill-form").on("click", function () {
  showScreen("registForm");
});

$("#regist-submit-btn").on("click", function () {
  showScreen("scanHairAnalyzer");
});

$("#agree-instruction-btn").on("click", function () {
  showScreen("scanHair");
  // selfie = true;
});

// $("#take-selfie-hair").on("click", function () {
//   showScreen("scanHair");
//   selfie = true;
// });

$(".button-to-home").on("click", function () {
  window.location.reload();
}); 

$(".back-to-home").on("click", function () {
  window.location.reload();
});

$("#register-form .icon-back").on("click", function () {
  window.location.reload();
});

$("#button-to-take-selfie-hair").on("click", function () {
  showScreen("scanHairAnalyzer");
});

$(".question-wrapper:not(.question-multiselect) .question-list").on(
  "click",
  function () {
    $(
      ".question-wrapper:not(.question-multiselect) .question-list"
    ).removeClass("question-selected");
    $(this).addClass("question-selected");
    $(this)
      .parents(".question-wrapper")
      .next()
      .find("button")
      .removeClass("disabled");
  }
);

$(".question-multiselect .question-list").on("click", function () {
  $(this).toggleClass("question-selected");
  $(this)
    .parents(".question-wrapper")
    .next()
    .find("button")
    .removeClass("disabled");
});

$("#page-question-livein .question-multiselect .question-list").on(
  "click",
  function () {
    $("#page-question-livein .question-multiselect .question-list").addClass(
      "question-selected"
    );
    $(this)
      .parents(".question-wrapper")
      .next()
      .find("button")
      .removeClass("disabled");
  }
);

// $("#button-to-hairstyle1, #button-to-hairstyle2, #button-to-hairstyle3, #button-to-hairstyle4").on("click", async function () {
//   const container = $("#hairstyle-grid-inner-list");
//   container.empty();

//   // -------------------- Step 1: Define local gallery files --------------------
//   const galleryFiles = [
//     "side_swept.jpg",
//     "buzzcut.jpg",
//     "buzzcut2.jpg",
//     "layered.jpg",
//     "long_layered.jpg",
//     "pompadour.jpg",
//     "side wave.jpg",
//     "two_block.jpg",
//     "wolfcut.jpg"
//   ];

//   // -------------------- Step 2: Convert gallery URLs to base64 --------------------
//   async function urlToBase64(url) {
//     const res = await fetch(url);
//     const blob = await res.blob();
//     return await new Promise((resolve) => {
//       const reader = new FileReader();
//       reader.onloadend = () => resolve(reader.result.split(',')[1]); // remove "data:image/png;base64,"
//       reader.readAsDataURL(blob);
//     });
//   }

//   console.log("🚀 Converting gallery images to base64...");
//   const remaining_gallery = await Promise.all(
//     galleryFiles.map(file => urlToBase64(`./gallery/${file}`))
//   );
//   console.log(`✅ Converted ${remaining_gallery.length} gallery images`);

//   // -------------------- Step 3: Prepare face --------------------
//   // console.log("uploadedFaceBase64:", uploadedFaceBase64);
//   const faceBase64 = uploadedFaceBase64;

//   // -------------------- Step 4: Prepare batches --------------------
//   const batchSize = 3;
//   let hairstyleData = []; // store processed results

//   const batchPayloads = [];
//   for (let i = 0; i < remaining_gallery.length; i += batchSize) {
//     const batchGallery = remaining_gallery.slice(i, i + batchSize);
//     batchPayloads.push(batchGallery.map((galleryBase64) => ({
//       face: faceBase64,
//       gallery: galleryBase64,
//       face_repeat: faceBase64
//     })));
//   }

//   // -------------------- Step 5: Process batch --------------------
//   async function processBatch(payload, batchIndex) {
//     try {
//       const res = await fetch("/api/process-gallery-batch", {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ images_base64: payload })
//       });
//       const result = await res.json();

//       console.log(`✅ Batch ${batchIndex + 1} result:`, result);

//       if (result.results) {
//         result.results.forEach((item, idx) => {
//           const overallIndex = batchIndex * batchSize + idx;
//           // Remove extension using replace
//           const nameWithoutExt = galleryFiles[overallIndex].replace(/\.[^/.]+$/, "");
//           hairstyleData[overallIndex] = {
//             output_base64: item.output_base64,
//             name: nameWithoutExt // name without .jpg
//           };
//         });

//         renderHairstyleItems(hairstyleData, lazyNine);
//       } else {
//         console.error(`⚠️ No results in batch ${batchIndex + 1}`, result);
//       }
//     } catch (err) {
//       console.error(`❌ Error in batch ${batchIndex + 1}:`, err);
//     }
//   }

//   // -------------------- Step 6: Limit concurrency --------------------
//   const concurrency = 2;
//   let index = 0;
//   while (index < batchPayloads.length) {
//     const chunk = batchPayloads.slice(index, index + concurrency);
//     await Promise.all(chunk.map((payload, idx) => processBatch(payload, index + idx)));
//     index += concurrency;
//   }

//   console.log("🎉 All gallery batches processed!");
// });

  
// async function bebas(){
//     if (!uploadedFaceBase64) {
//         console.error("⚠️ No uploaded face available!");
//         return;
//     }

// //     const buttonHairMap = {
// //         "button-to-hairstyle1": "straight",
// //         "button-to-hairstyle2": "wavy",
// //         "button-to-hairstyle3": "curly",
// //         "button-to-hairstyle4": "tight_curly"
// //     };

// //     const buttonId = $(this).attr("id");
// //     const hairType = buttonHairMap[buttonId];
// //     if (!hairType) {
// //         console.error("⚠️ Hair type mapping not found for button:", buttonId);
// //         return;
// //     }

// //     try {
// //         container.text('Loading hairstyles...');

// //         const res = await fetch("/api/fuse-hair", {
// //             method: "POST",
// //             headers: { "Content-Type": "application/json" },
// //             body: JSON.stringify({
// //                 face_base64: uploadedFaceBase64,
// //                 hair_type: hairType
// //             })
// //         });

// //         const data = await res.json();

// //         if (!data.success || !data.hairfastgan_results?.length) {
// //             container.text('No hairstyles available for this type.');
// //             console.warn("⚠️ No hairstyles returned from /api/fuse-hair", data);
// //             return;
// //         }

// //         container.empty();

// //         data.hairfastgan_results.forEach((item, index) => {
// //             // Outer card div
// //             const card = $("<div>", { 
// //                 class: "hairstyle-bg-card2D", 
// //                 css: { opacity: 0 }, 
// //                 "data-label": item.name || hairType 
// //             });

// //             // Hairstyle image
// //             const hairstyleImg = $("<img>", {
// //                 src: item.output_base64 ? `data:image/png;base64,${item.output_base64}` : item.output_url,
// //                 alt: item.name || hairType,
// //                 title: item.name || hairType,
// //                 class: "hairstyle-item-2D"
// //             });

// //             // Style name
// //             const styleName = $("<p>", { class: "card-2D-p", text: item.name || hairType });

// //             // Face shape
// //             const faceShape = $("<p>", { class: "card-2D-p-vert", text: item.faceShape || "OVAL" });

// //             // Product image
// //             const prodImg = $("<img>", { class: "hairstyle-prod-2D", src: "./assets/images/hair-powder.png" });

// //             // Append elements to card
// //             card.append(hairstyleImg, styleName, faceShape, prodImg);

// //             // Append card to container
// //             container.append(card);

// //             // Fade-in effect
// //             setTimeout(() => {
// //                 card.css({ transition: "opacity 0.5s", opacity: 1 });
// //             }, 50 * index);
// //         });

//         console.log(`🎉 Rendered ${data.hairfastgan_results.length} ${hairType} hairstyles`);
//     } catch (err) {
//         container.text('Error loading hairstyles.');
//         console.error("❌ Error calling /api/fuse-hair:", err);
//     }
// }
// ✅ Event delegation untuk klik card
$("#hairstyle-grid-inner-list").on("click", ".hairstyle-bg-card2D", function () {
    $(".hairstyle-bg-card2D").removeClass("selected");
    $(this).addClass("selected");
    const index = $(this).attr('data-model-index');
    const selected = hairFiles[index];
    console.log(selected, index)
    if (!selected) return;

    if (modelGroup) loadHairstyle(modelGroup, selected.model);

    $('.hairstyle-name-2').html(selected.name); 
    showScreen("hairstyle");

});



// showScreen("pageQuestionHair");
// showScreen('scanHair');

