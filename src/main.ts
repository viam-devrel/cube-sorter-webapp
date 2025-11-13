import * as VIAM from '@viamrobotics/sdk';

const HOST = import.meta.env.VITE_HOST;
const API_KEY_ID = import.meta.env.VITE_API_KEY_ID;
const API_KEY = import.meta.env.VITE_API_KEY;

const connectionStatusEl = <HTMLElement>(
  document.getElementById('connection-status')
);
const startEl = <HTMLButtonElement>document.getElementById('start');
const stopEl = <HTMLButtonElement>document.getElementById('stop');
const resetEl = <HTMLButtonElement>document.getElementById('reset');

const reconnectAbortSignal = { abort: false };
let isSearchingForObject = true;

// Keep a persistent reference to the canvas and its context
let detectionsCanvas: HTMLCanvasElement | null = null;
let detectionsCtx: CanvasRenderingContext2D | null = null;

// Disable control panel
function disableControlPanel() {
  startEl.setAttribute('disabled', '');
  startEl.style.opacity = '0.3';
  stopEl.setAttribute('disabled', '');
  stopEl.style.opacity = '0.3';
  resetEl.setAttribute('disabled', '');
  resetEl.style.opacity = '0.3';
}

// Enable control panel
function enableControlPanel() {
  startEl.removeAttribute('disabled');
  startEl.style.opacity = '1.0';
  stopEl.removeAttribute('disabled');
  stopEl.style.opacity = '1.0';
  resetEl.removeAttribute('disabled');
  resetEl.style.opacity = '1.0';
}

// Sets up the detections view by creating a single, reusable canvas. Call on startup.
function initializeDetectionsView() {
  const imageContainer = document.getElementById('detectionsView');
  if (imageContainer) {
    // Create the canvas element
    detectionsCanvas = document.createElement('canvas');
    
    // Get the context for drawing
    detectionsCtx = detectionsCanvas.getContext('2d');
    
    // Append the canvas to the container. This is the LAST time
    // we will manipulate the DOM for the canvas.
    imageContainer.innerHTML = ''; // Clear any placeholders
    imageContainer.appendChild(detectionsCanvas);
  } else {
    console.error("Detections container 'detectionsView' not found!");
  }
}

async function getEverythingFromVisionService(vision: VIAM.VisionClient) {
  const captureAll = await vision.captureAllFromCamera('overhead-cam', {
    returnImage: true,
    returnClassifications: true,
    returnDetections: true,
    returnObjectPointClouds: false,
  });
  return captureAll;
}

// Converts what we get from vision service to base64 string.
async function convertToBase64String(rawImage: Uint8Array) {
  return btoa(Array.from(rawImage)
          .map((byte) => String.fromCharCode(byte))
          .join('')
        );
}

async function renderDetectedObject(visionServiceData: any) {
  // Use the globally available context and canvas.
  // If they don't exist, we can't draw, so we exit early.
  if (!detectionsCanvas || !detectionsCtx) {
    console.error("Detections canvas is not initialized.");
    return;
  }
  
  // Reference detectionsCtx for all drawing operations.
  const ctx = detectionsCtx;
  
  if (visionServiceData.image) {
    // Create image element to load the base64 data
    const img = new Image();
    const base64string = await convertToBase64String(visionServiceData.image.image);
    
    img.onload =  () => {
      // Set canvas dimensions to match new image from stream
      if (detectionsCanvas) {
        detectionsCanvas.width = img.width;
        detectionsCanvas.height = img.height;

        // Clear old drawing
        ctx.clearRect(0, 0, detectionsCanvas.width, detectionsCanvas.height);
      }

      // Draw the original image
      ctx.drawImage(img, 0, 0);
      
      // Draw bounding boxes and labels for each detection
      visionServiceData.detections.forEach((detection) => {
        // Convert coordinates to numbers explicitly
        const xMin = Number(detection.xMin || 0);
        const yMin = Number(detection.yMin || 0);
        const xMax = Number(detection.xMax || 0);
        const yMax = Number(detection.yMax || 0);
        const width = xMax - xMin;
        const height = yMax - yMin;
        
        // Draw bounding box
        ctx.strokeStyle = '#00ef83'; // Viam blue accent
        ctx.lineWidth = 2;
        ctx.strokeRect(xMin, yMin, width, height);
        
        // Draw label background
        const label = `${detection.className} (${(detection.confidence * 100).toFixed(1)}%)`;
        ctx.font = '16px Arial';
        const textMetrics = ctx.measureText(label);
        const textHeight = 20;

        ctx.fillStyle = '#00ef83';
        ctx.fillRect(xMin, yMin - textHeight, textMetrics.width + 8, textHeight);

        // Draw label text
        ctx.fillStyle = '#000000';
        ctx.fillText(label, xMin + 4, yMin - 4);
        
        // Render object location
        const objCoordinatesSpan = document.getElementById('detected-obj-coordinates');
        
        if (objCoordinatesSpan) {
          objCoordinatesSpan.innerText = `[x: ${(xMin + 4).toString()}, y: ${(yMin - 4).toString()}]` || '';
        }

      });
    };

    img.src = `data:image/jpeg;base64,${base64string}`;
  }
}

const handleConnectionStateChange = (event: unknown) => {
  updateConnectionStatus(
    (event as { eventType: VIAM.MachineConnectionEvent }).eventType
  );
};

const updateConnectionStatus = (eventType: VIAM.MachineConnectionEvent) => {
  switch (eventType) {
    case VIAM.MachineConnectionEvent.CONNECTING:
      connectionStatusEl.textContent = '⏳ Connecting...';
      break;
    case VIAM.MachineConnectionEvent.CONNECTED:
      connectionStatusEl.textContent = '🟢 Connected';
      enableControlPanel();
      break;
    case VIAM.MachineConnectionEvent.DISCONNECTING:
      connectionStatusEl.textContent = '🟡 Disconnecting...';
      break;
    case VIAM.MachineConnectionEvent.DISCONNECTED:
      connectionStatusEl.textContent = '🔴 Disconnected';
      break;
  }
};

async function main() {
  disableControlPanel();

  const host = HOST;

  const machine = await VIAM.createRobotClient({
    host,
    credentials: {
      type: "api-key",
      payload: API_KEY,
      authEntity: API_KEY_ID,
    },
    signalingAddress: "https://app.viam.com:443",
  });
  updateConnectionStatus(VIAM.MachineConnectionEvent.CONNECTED);
  machine.on('connectionstatechange', handleConnectionStateChange);

  const arm = new VIAM.ArmClient(machine, 'dofbot-arm');
  const gripper = new VIAM.GripperClient(machine, 'dofbot-gripper');

  startEl.addEventListener('click', async () => {
    initializeDetectionsView();

    await arm.moveToJointPositions([0,0,0,90,0]);

    const vision = new VIAM.VisionClient(machine, 'block-detection-service');
    isSearchingForObject = true;

    // To get a "stream" of sorts, need to continuously poll for frames from vision service.
    while (isSearchingForObject) {
      try {
        const visionServiceData = await getEverythingFromVisionService(vision);
        console.log(visionServiceData)

        await renderDetectedObject(visionServiceData);

      } catch (error) {
        console.error('Vision stream error:', error);
      }
      // Artificial delay, used to still get somewhat "real-time" feed of vision service
      // while balancing number of calls being made to grab new vision service data.
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    }
  });

  stopEl.addEventListener('click', async () => {
    // If currently establishing initial connection, abort.
    reconnectAbortSignal.abort = true;
    isSearchingForObject = false

    await arm.stop();
  });

  resetEl.addEventListener('click', async () => {
    isSearchingForObject = false
    await arm.moveToJointPositions([0,25,0,90,0]);
  });

  
};

main();