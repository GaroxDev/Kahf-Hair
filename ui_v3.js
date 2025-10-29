import * as THREE from "three";
import { MindARThree } from "mindar-face-three";

const mindarThree = new MindARThree({
  container: document.getElementById("face-scan-container"),
  uiLoading: false,
  uiScanning: false,
  uiError: false,
});

const { renderer, scene, camera } = mindarThree;

let capturedImages = [];

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
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Updated fragment shader with more solid scanning line
const fragmentShader = `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 lineColor;
  uniform float lineSpeed;
  uniform float lineWidth;
  uniform float glowWidth;
  varying vec2 vUv;
  
  void main() {
    // Original texture
    vec4 texColor = texture2D(map, vUv);
    
    // Animated line position (0-1 range)
    float linePos = abs(fract(time * lineSpeed / 2.0) * 2.0 - 1.0);
    
    // Distance to line
    float dist = abs(vUv.y - linePos);
    
    // Sharper line with less smoothstep blending
    float lineIntensity = 1.0 - smoothstep(0.0, lineWidth, dist);
    float glowIntensity = 0.5 - smoothstep(lineWidth, lineWidth + glowWidth, dist);
    
    // More intense core with stronger glow
    vec3 scanEffect = lineColor * (lineIntensity * 0.5 + glowIntensity * 0.5);
    
    // Blend with original texture (use max to make effect more prominent)
    vec3 finalColor = max(texColor.rgb, scanEffect);
    
    // Increase overall opacity by reducing alpha blending
    float alpha = max(texColor.a, (lineIntensity + glowIntensity) * 0.7);
    
    gl_FragColor = vec4(finalColor, alpha);
  }
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

const postData = {
  id: "1756873534386",
  sources: [],
  landmarks: [""],
};

function completeScanSkin() {
  $(".scan-helper-text").text("Analyzing...");
  $("#scan-progress").css("width", "100%");
  console.log(postData);
  fetch("https://skinanalyzer.wardahbeauty.com/analyze_v3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(postData),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    })
    .then((data) => {
      console.log("Success:", data);
      let responseData = data.data;
      const baseUrl = data.baseUrl;

      // Update all face images in result sections
      document
        .querySelectorAll(".image-face-skin-result img")
        .forEach((img) => {
          img.src = `${baseUrl}/${data.data[0][0].image}`;
        });

      // Update all parameter result images
      document.querySelectorAll(".parameter-result img").forEach((img) => {
        img.src = `${baseUrl}/${data.data[0][0].image}`;
      });

      // Update diagnostic face images
      const diagnosticImages = document.querySelectorAll(".face-side img");
      diagnosticImages[0].src = `${baseUrl}/${data.data[2][0].image}`; // left
      diagnosticImages[1].src = `${baseUrl}/${data.data[0][0].image}`; // straight
      diagnosticImages[2].src = `${baseUrl}/${data.data[1][0].image}`; // right

      // Mapping for surface issues
      const surfaceMapping = {
        darkspot: "darkspot_detection",
        acne: "acne_detection",
        pore: "largepores_detection",
        "acne-scars": "acnescar_detection",
        dullness: "dullness_detection",
      };

      // Mapping for deep level issues
      const deepMapping = {
        wrinkles: "wrinkle_detection",
        eyebags: "eyebags_detection",
        finelines: "finelines_detection",
        hyperpigmentation: "hyperpigmentation_detection_unet",
        "loss-firmness": "lossfirmness",
        pigmen: "negative_image",
        colagen: "negative_image",
        aging: "predicted_age",
      };

      // Update surface issues tabs
      Object.keys(surfaceMapping).forEach((tabSuffix) => {
        const tabId = `tabcontent-${tabSuffix}`;
        const issueId = surfaceMapping[tabSuffix];
        const obj = responseData[0].find((item) => item.id === issueId);
        if (obj && obj.image) {
          const imageUrl = `${baseUrl}/${obj.image}`;
          const tabPane = document.getElementById(tabId);
          if (tabPane) {
            const mainImage = tabPane.querySelector(
              ".image-face-skin-result img"
            );
            const paramImage = tabPane.querySelector(".parameter-result img");
            if (mainImage) {
              mainImage.src = imageUrl;
            }
            if (paramImage) {
              paramImage.src = imageUrl;
            }
          }
        }
      });

      // Update deep level tabs
      Object.keys(deepMapping).forEach((tabSuffix) => {
        const tabId = `tabcontent-${tabSuffix}`;
        const issueId = deepMapping[tabSuffix];
        const obj = responseData[0].find((item) => item.id === issueId);
        if (obj && obj.image) {
          const imageUrl = `${baseUrl}/${obj.image}`;
          const tabPane = document.getElementById(tabId);
          if (tabPane) {
            const mainImage = tabPane.querySelector(
              ".image-face-skin-result img"
            );
            const paramImage = tabPane.querySelector(".parameter-result img");
            if (mainImage) {
              mainImage.src = imageUrl;
            }
            if (paramImage) {
              paramImage.src = imageUrl;
            }
          }
        }
      });

      // Update diagnostic tab with three views
      // Front (straight) view
      const frontView = responseData[0].find((item) => item.surface_photo);
      if (frontView) {
        const straightImageUrl = `${baseUrl}/${frontView.surface_photo}`;
        const straightImg = document.querySelector(".face-straight img");
        if (straightImg) {
          straightImg.src = straightImageUrl;
        }
      }

      // Right view
      const rightView = responseData[1].find((item) => item.surface_photo);
      if (rightView) {
        const rightImageUrl = `${baseUrl}/${rightView.surface_photo}`;
        const rightImg = document.querySelector(".face-right img");
        if (rightImg) {
          rightImg.src = rightImageUrl;
        }
      }

      // Left view
      const leftView = responseData[2].find((item) => item.surface_photo);
      if (leftView) {
        const leftImageUrl = `${baseUrl}/${leftView.surface_photo}`;
        const leftImg = document.querySelector(".face-left img");
        if (leftImg) {
          leftImg.src = leftImageUrl;
        }
      }

      // Also, update the skin age in the diagnostic tab if available
      const predictedAgeObj = responseData[0].find(
        (item) => item.id === "predicted_age"
      );
      if (predictedAgeObj && predictedAgeObj.predicted_age) {
        const ageElement = document.querySelector(".card-intro span");
        if (ageElement) {
          ageElement.textContent = predictedAgeObj.predicted_age;
        }
      }
      showScreen("pageResultSkin");
    })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    })
    .then((data) => {
      console.log("Success:", data);
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}

// ui.js
// Prevent page reload on unhandled promise rejection
window.addEventListener("unhandledrejection", function (event) {
  console.error("Unhandled rejection:", event.reason);
  event.preventDefault();
});

async function startFaceScan() {
  try {
    await mindarThree.start();
    clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
      // Update face detection
      if (startScanFace) {
        onUpdate(); // Your existing face detection update function
      }

      // Scanning logic
      if (startCapture && currentStepIndex < scanSteps.length) {
        const currentStep = scanSteps[currentStepIndex];

        if (
          currentStep.orientation === "straight" &&
          Math.abs(window.eulerY) < 0.2 &&
          !lookedStraight
        ) {
          const capture = captureFrame("straight");
          if (capture) {
            capturedImages.push(capture);
            lookedStraight = true;
            setTimeout(() => {
              nextStep();
            }, 2000);
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
            nextStep();
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
            nextStep();
          }
        }

        // Check for completion
        const straightImage = capturedImages.find(
          (img) => img.orientation === "straight"
        );
        const leftImage = capturedImages.find(
          (img) => img.orientation === "left"
        );
        const rightImage = capturedImages.find(
          (img) => img.orientation === "right"
        );

        if (straightImage)
          $("<img>")
            .addClass("straight-face")
            .attr("src", straightImage.dataUrl)
            .appendTo("#captured-photo");
        if (leftImage)
          $("<img>")
            .addClass("left-face")
            .attr("src", leftImage.dataUrl)
            .appendTo("#captured-photo");
        if (rightImage)
          $("<img>")
            .addClass("right-face")
            .attr("src", rightImage.dataUrl)
            .appendTo("#captured-photo");

        const straightFaceSrc = straightImage?.dataUrl?.split(",")[1];
        const leftFaceSrc = leftImage?.dataUrl?.split(",")[1];
        const rightFaceSrc = rightImage?.dataUrl?.split(",")[1];

        if (straightFaceSrc && leftFaceSrc && rightFaceSrc) {
          if (window.location.pathname === "/") {
            postData.id = "123";
            postData.sources.push(straightFaceSrc);
            postData.sources.push(leftFaceSrc);
            postData.sources.push(rightFaceSrc);
            // postData.raw_landmarks.push('')
            completeScanSkin();
          }
        }
      }

      // Update face mesh animation
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

startFaceScan();

// Scan button handler
$("#scan-btn").on("click", function (e) {
  e.preventDefault(); // ← Add this
  e.stopPropagation(); // ← Add this

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

// Store user answers
const userAnswers = {
  describe: null,
  pores: null,
  afternoon: null,
  blemishes: null,
  morning: null,
};

// Skin type descriptions
const skinTypes = {
  dry: {
    title: "DRY",
    description: "Tight and flaky, less visible pores.",
    image: "/assets/images/dry.png",
  },
  oily: {
    title: "OILY",
    description: "Shiny appearance, enlarged pores, prone to breakouts.",
    image: "/assets/images/oily.png",
  },
  normal: {
    title: "NORMAL",
    description: "Balanced, comfortable, few imperfections.",
    image: "/assets/images/normal.png",
  },
  acne: {
    title: "ACNE PRONE",
    description: "Easily irritated, prone to redness and reactions.",
    image: "/assets/images/acne-prone.png",
  },
  combination: {
    title: "COMBINATION",
    description: "Oily T-zone with normal to dry cheeks.",
    image: "/assets/images/dry.png",
  },
};

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

const regexEmail = (email) => {
  return /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
    email
  );
};

const regexPhone = (phone) => {
  return /^0[1-9][0-9]{7,11}$/.test(phone);
};

let nameValid = false,
  phoneValid = false,
  tncValid = false,
  tnc2Valid = true;
$("#form input")
  .on("keyup keydown change", function () {
    // Check validity for name field
    if ($(this).hasClass("name")) {
      if ($(".name").val().trim() === "") {
        $(".name").next(".error-validation").fadeIn(300);
        nameValid = false;
      } else {
        $(".name").next(".error-validation").fadeOut(300); // Hide error if valid
        nameValid = true;
      }
    }

    // Check validity for phone field
    if ($(this).hasClass("phone")) {
      let phoneValue = $(this).val().trim();

      const $error = $(this)
        .closest(".input-wrapper")
        .find(".error-validation");

      if (phoneValue === "" || !regexPhone(phoneValue)) {
        $error.fadeIn(300);
        phoneValid = false;
      } else {
        $error.fadeOut(300);
        phoneValid = true;
      }
    }

    // Check validity for phone field
    if ($(this).hasClass("tnc")) {
      if ($(".tnc").prop("checked", true)) {
        tncValid = true;
      }
    }

    // Check validity for phone field
    if ($(this).hasClass("tnc2")) {
      if ($(".tnc2").prop("checked", true)) {
        tnc2Valid = true;
      }
    }

    // Toggle the submit button state
    if (nameValid && phoneValid && tncValid && tnc2Valid) {
      $("#submit-form").removeClass("disabled");
    } else {
      $("#submit-form").addClass("disabled");
    }
  })
  .on("blur", function () {
    $(".input-autocomplete").slideUp(300);
  });

$("#product-hair-screen .icon-back").on("click", function () {
  $(".owl-item:first-child .hairstyle-item").click();
  showScreen("hairstyle");
});

$("#button-to-hairstyle").on("click", function () {
  showScreen("hairstyle");
});

$("#hairstyle-list-screen .icon-back").on("click", function () {
  showScreen("hairstyle");
});

$("#home-page-hair .icon-back").on("click", function () {
  window.location.reload();
});

$("#face-scan-hair .icon-back").on("click", function () {
  window.location.reload();
});

$("#hair-analyzer-splash .icon-back").on("click", function () {
  window.location.reload();
});

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

// SKIN ANALYZER

var selfie = false;

$("#page-result .icon-back").on("click", function () {
  // Reset scanning state
  startCapture = false;
  lookedRight = false;
  lookedLeft = false;
  lookedStraight = false;
  currentStepIndex = 0;
  capturedImages = [];

  // Clear any ongoing scan timeout
  if (timeOutScan) {
    clearTimeout(timeOutScan);
    timeOutScan = null;
  }

  // Reset UI elements
  $("#scan-helper-text").text("");
  $("#scan-progress").css("width", "0%");
  $("#scan-btn").css("pointer-events", "all").html("Start Scan");

  // Clear captured images display
  $("#captured-photo").empty();

  // Hide result screen and show scan screen
  showScreen("scanSkin");

  // Reset scan animation if needed
  $(".scan-animation").hide();
  $("#face-scan-container").removeClass("scanning");
});

$("#button-start").on("click", function () {
  if (window.location.pathname === "/hair") {
    showScreen("scanHairAnalyzer");
  } else {
    showScreen("pageIntro");
  }
});

$("#button-to-age").on("click", function () {
  showScreen("pageQuestionAge");
});

$("#button-to-personal-concerns").on("click", function () {
  showScreen("pageQuestionAge");
});
$("#page-intro .icon-back").on("click", function () {
  showScreen("homePage");
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

$("#button-to-transportation").on("click", function () {
  showScreen("questionTransportation");
});

$("#button-to-livein").on("click", function () {
  showScreen("questionLivein");
});

$("#button-to-sport").on("click", function () {
  showScreen("questionSport");
});

$("#button-fill-form").on("click", function () {
  showScreen("registForm");
});

$("#regist-submit-btn").on("click", function () {
  showScreen("scanHair");
});

$("#take-selfie").on("click", function () {
  showScreen("scanSkin");
  selfie = true;
});

$("#take-selfie-hair").on("click", function () {
  showScreen("scanHair");
  selfie = true;
});

$("#page-skin-score .icon-back").on("click", function () {
  showScreen("pageSkinResult");
});

$("#button-to-skin-product").on("click", function () {
  showScreen("pageSkinProduct");
});

$("#submit-form").on("click", function () {
  showScreen("pageQuestionAge");
});

$(".button-to-home").on("click", function () {
  window.location.reload();
});

$(".back-to-home").on("click", function () {
  window.location.reload();
});

$("#register-form .icon-back").on("click", function () {
  window.location.reload();
});

$("#button-to-skin-condition").on("click", function () {
  showScreen("questionSkinCondition");
});

$("#button-backto-skin-condition").on("click", function () {
  showScreen("questionSkinCondition");
  // $('#page-question-skin-condition .question-list:nth-child(4)').addClass('question-selected')
  $("#button-after-skin-condition").removeClass("disabled");
});

$("#button-to-personal-type").on("click", function () {
  showScreen("questionPersonalType");
});

$("#button-to-live-in").on("click", function () {
  showScreen("questionLivein");
});

$("#button-to-direct-sunlight").on("click", function () {
  showScreen("questionDirectSunlight");
});

$("#button-to-personal-concerns").on("click", function () {
  showScreen("questionPersonalConcern");
});

$("#button-to-intro-analyzer").on("click", function () {
  showScreen("scanAnalyzer");
});

$("#button-to-take-selfie-hair").on("click", function () {
  showScreen("scanHairAnalyzer");
});

$("#button-after-skin-condition").on("click", function () {
  if ($(".i-dont-know").hasClass("question-selected")) {
    showScreen("questionDescribeSkin");
  } else if ($(".normal").hasClass("question-selected")) {
    showScreen("questionNormalSkin");
  } else if ($(".oily").hasClass("question-selected")) {
    showScreen("questionOilySkin");
  } else if ($(".combination").hasClass("question-selected")) {
    showScreen("questionCombinationSkin");
  } else if ($(".dull").hasClass("question-selected")) {
    showScreen("questionDullSkin");
  } else if ($(".dry").hasClass("question-selected")) {
    showScreen("questionDrySkin");
  } else if ($(".acne").hasClass("question-selected")) {
    showScreen("questionAcneSkin");
  }
});

$("#button-to-pores").on("click", function () {
  showScreen("questionPoresSkin");
});

$("#button-to-afternoon").on("click", function () {
  showScreen("questionAfternoon");
});

$("#button-to-blemishes").on("click", function () {
  showScreen("questionBlemishes");
});

$("#button-to-morning").on("click", function () {
  showScreen("questionMorning");
});

$("#button-to-result-question").on("click", function () {
  showScreen("resultSkinType");
});

$(".progress-bar").each(function () {
  let value = parseInt($(this).attr("data-value"));

  if (value >= 70) {
    $(this).css("background-color", "#F04E4F"); // Red
  } else if (value >= 50) {
    $(this).css("background-color", "#F08521"); // Green (moved up)
  } else if (value >= 30) {
    $(this).css("background-color", "#8EB600"); // Orange
  } else if (value >= 5) {
    $(this).css("background-color", "#ffc107"); // Yellow (lighter orange)
  } else {
    $(this).css("background-color", "transparent"); // Yellow (lighter orange)
    $(this).css("color", "#000000"); // Yellow (lighter orange)
  }
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

$("#page-question-age .icon-back").on("click", function () {
  showScreen("pageIntro");
});

$("#page-question-skin-condition .icon-back").on("click", function () {
  showScreen("pageQuestionAge");
});

$("#page-question-direct-sunlight .icon-back").on("click", function () {
  showScreen("questionSkinCondition");
});

$("#page-question-dry-concerns .icon-back").on("click", function () {
  showScreen("questionDirectSunlight");
});

$("#page-question-livein .icon-back").on("click", function () {
  showScreen("questionPersonalConcern");
});

$("#skin-analyzer-splash .icon-back").on("click", function () {
  showScreen("questionLivein");
});

$("#face-scan-skin .icon-back").on("click", function () {
  showScreen("scanAnalyzer");
});

$("#face-scan-hair .icon-back").on("click", function () {
  showScreen("scanAnalyzer");
});

$("#page-question-livein .icon-back").on("click", function () {
  showScreen("questionPersonalConcern");
});

$("#page-question-livein .icon-back").on("click", function () {
  showScreen("questionPersonalConcern");
});

$("#page-question-describe-skin .icon-back").on("click", function () {
  showScreen("questionSkinCondition");
});

$("#page-question-pores .icon-back").on("click", function () {
  showScreen("questionDescribeSkin");
});

$("#page-question-afternoon .icon-back").on("click", function () {
  showScreen("questionPoresSkin");
});

$("#page-question-blemishes .icon-back").on("click", function () {
  showScreen("questionAfternoon");
});

$("#page-question-morning .icon-back").on("click", function () {
  showScreen("questionBlemishes");
});

$(".page-question-skin-concern .icon-back").on("click", function () {
  showScreen("questionSkinCondition");
});

// $("#page-form .icon-back").on("click", function () {
//   if (selfie) {
//     showScreen("pageSkinResult");
//   } else {
//     showScreen("scanAnalyzerSelection");
//   }
// });

$("#skin-analyzer-selection .icon-back").on("click", function () {
  showScreen("scanAnalyzer");
});

// Set up question selection
$(".question-list").on("click", function () {
  // Remove selected class from all options in this question
  $(this).siblings().removeClass("selected");

  // Add selected class to clicked option
  $(this).addClass("selected");

  // Enable the next button
  const container = $(this).closest(".kahf-screen");
  container.find("button").removeClass("disabled");

  // Store the answer
  const screenId = container.attr("id");
  const answer = $(this).data("value");

  if (screenId === "page-question-describe-skin") {
    userAnswers.describe = answer;
  } else if (screenId === "page-question-pores") {
    userAnswers.pores = answer;
  } else if (screenId === "page-question-afternoon") {
    userAnswers.afternoon = answer;
  } else if (screenId === "page-question-blemishes") {
    userAnswers.blemishes = answer;
  } else if (screenId === "page-question-morning") {
    userAnswers.morning = answer;
  }
});

// Navigation between screens
$("#button-to-pores").on("click", function () {
  if (!$(this).hasClass("disabled")) {
    showScreen("questionPoresSkin");
  }
});

$("#button-to-afternoon").on("click", function () {
  if (!$(this).hasClass("disabled")) {
    showScreen("questionAfternoon");
  }
});

$("#button-to-blemishes").on("click", function () {
  if (!$(this).hasClass("disabled")) {
    showScreen("questionBlemishes");
  }
});

$("#button-to-morning").on("click", function () {
  if (!$(this).hasClass("disabled")) {
    showScreen("questionMorning");
  }
});

$("#button-style-vault").on("click", function () {
  showScreen("hairstyleList");
});

// $("#button-to-hair").on("click", function () {
//   showScreen("pageQuestionHair");
// });

// $("#hairstyle-continue-btn").on("click", function () {
//   showScreen("productHair");
// });

$("#button-to-result-question").on("click", function () {
  if (!$(this).hasClass("disabled")) {
    // Calculate result
    const result = calculateResult();

    // Display result
    $(".image-result-skin-wrapper img").attr("src", skinTypes[result].image);
    $(".skin-result-content h2").text(skinTypes[result].title);
    $(".skin-result-content h4").text(skinTypes[result].description);

    showScreen("resultSkinType");
  }
});

// Back button functionality
$(".icon-back, .back-button").on("click", function () {
  const currentScreen = $(this).closest(".kahf-screen");

  if (currentScreen.attr("id") === "page-question-pores") {
    showScreen("questionDescribeSkin");
  } else if (currentScreen.attr("id") === "page-question-afternoon") {
    showScreen("questionPoresSkin");
  } else if (currentScreen.attr("id") === "page-question-blemishes") {
    showScreen("questionAfternoon");
  } else if (currentScreen.attr("id") === "page-question-morning") {
    showScreen("questionBlemishes");
  } else if (currentScreen.attr("id") === "page-result-question") {
    showScreen("questionMorning");
  }
});

// Restart quiz
$("#button-restart").on("click", function () {
  // Reset answers
  for (let key in userAnswers) {
    userAnswers[key] = null;
  }

  // Clear selections
  $(".question-list").removeClass("selected");

  // Disable all buttons
  $(".kahf-btn").addClass("disabled");

  // Go to first screen
  showScreen("questionDescribeSkin");
});

// Calculate the result based on answers
function calculateResult() {
  // Count occurrences of each skin type in answers
  const counts = {
    dry: 0,
    oily: 0,
    normal: 0,
    sensitive: 0,
    combination: 0,
  };

  // Count each answer
  for (let key in userAnswers) {
    if (userAnswers[key]) {
      counts[userAnswers[key]]++;
    }
  }

  // Find the skin type with the highest count
  let maxCount = 0;
  let result = "normal"; // default

  for (let type in counts) {
    if (counts[type] > maxCount) {
      maxCount = counts[type];
      result = type;
    }
  }

  return result;
}

showScreen("pageQuestionHair");