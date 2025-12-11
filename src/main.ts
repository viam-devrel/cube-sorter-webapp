import * as VIAM from '@viamrobotics/sdk';
import { getMachineKeyFromURL, getCredentialsFromCookie } from './utils';
import { Struct, StreamClient } from '@viamrobotics/sdk';

type CaptureAllResponse = {
  image?: VIAM.cameraApi.Image;
  classifications: VIAM.visionApi.Classification[];
  detections: VIAM.visionApi.Detection[];
  objectPointClouds: VIAM.commonApi.PointCloudObject[];
  extra?: VIAM.Struct;
}

let camera: VIAM.CameraClient;
let stream: VIAM.StreamClient
let machine: VIAM.RobotClient;

const connectionStatusEl = <HTMLElement>(
  document.getElementById('connection-status')
);
const startEl = <HTMLButtonElement>document.getElementById('start');
const stopEl = <HTMLButtonElement>document.getElementById('stop');
const resetEl = <HTMLButtonElement>document.getElementById('reset');
const objCoordinatesSpan = document.getElementById('detected-obj-coordinates');

const reconnectAbortSignal = { abort: false };
let isSearchingForObject = true;
let isStreaming = false;
let animationFrameId: number;

// Keep a persistent reference to the canvas and its context
let detectionsCanvas: HTMLCanvasElement | null = null;
let detectionsCtx: CanvasRenderingContext2D | null = null;

// Home Joint Positions
const HOME_JOINT_POSITION = [
    -0.14130027592182162,
    -0.5319597721099854,
    0.6547077298164368,
    0.025027848780155182,
    1.0353490114212036,
    2.988678455352783
  ];

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
  const captureAll = await vision.captureAllFromCamera('realsense-cam', {
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

async function renderDetectedObject(visionServiceData: CaptureAllResponse) {
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
      const cvsWidth = detectionsCanvas.width;
      const cvsHeight = detectionsCanvas.height;

      if (detectionsCanvas) {
        // Clear old drawing
        ctx.clearRect(0, 0, cvsWidth, cvsHeight);
      }
      const scaleFactor = Math.max(cvsWidth / img.width, cvsHeight / img.height);
      const drawWidth = img.width * scaleFactor;
      const drawHeight = img.height * scaleFactor;

      // Draw the original image
      ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

      if (objCoordinatesSpan) {
        objCoordinatesSpan.innerText = ""
      }
      
      // Draw bounding boxes and labels for each detection
      visionServiceData.detections.forEach((detection) => {
        // Convert coordinates to numbers explicitly
        const xMin = Number(detection.xMin || 0) * drawWidth;
        const yMin = Number(detection.yMin || 0) * drawHeight;
        const xMax = Number(detection.xMax || 0) * drawWidth;
        const yMax = Number(detection.yMax || 0) * drawHeight;
        const width = xMax - xMin;
        const height = yMax - yMin;
        
        // Draw bounding box
        ctx.strokeStyle = '#00ef83'; // Viam blue accent
        ctx.lineWidth = 1;
        ctx.strokeRect(xMin, yMin, width, height);
        
        // Draw label background
        const label = `${detection.className} (${(detection.confidence * 100).toFixed(1)}%)`;
        ctx.font = '10px Helvetica';
        const textMetrics = ctx.measureText(label);
        const textHeight = 12;

        ctx.fillStyle = '#00ef83';
        ctx.fillRect(xMin, yMin - textHeight, textMetrics.width + 8, textHeight);

        // Draw label text
        ctx.fillStyle = '#000000';
        ctx.fillText(label, xMin + 4, yMin - 4);
        
        if (objCoordinatesSpan) {
          objCoordinatesSpan.innerText = `[x: ${(xMin + 4).toString()}, y: ${(yMin - 4).toString()}]` || '';
        }

      });
    };

    img.src = `data:image/jpeg;base64,${base64string}`;
  }
}

const startStream = () => {
  // Initialize stream client
  stream = new StreamClient(machine);
  isStreaming = true;
  updateCameraStream();
};

const stopStream = () => {
  isStreaming = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
};

const updateCameraStream = async () => {
  if (!isStreaming) return;

  try {
    const imageContainer = document.getElementById("detectionsView");
    
    if (imageContainer) {
      // Create or update video element
      let videoElement = imageContainer.querySelector("video");
      if (!videoElement) {
        videoElement = document.createElement("video");
        videoElement.autoplay = true;
        videoElement.muted = true;
        videoElement.style.width = '100%';
        videoElement.style.height = '100%';
        videoElement.style.objectFit = 'contain';
        imageContainer.innerHTML = "";
        imageContainer.appendChild(videoElement);
      }

      // Get and set the stream every frame
      const mediaStream = await stream.getStream("realsense-cam");
      videoElement.srcObject = mediaStream;

      // Ensure video plays
      try {
        await videoElement.play();
      } catch (playError) {
        console.error("Error playing video:", playError);
      }
    }

    // Request next frame
    animationFrameId = requestAnimationFrame(() => updateCameraStream());
  } catch (error) {
    console.error("Stream error:", error);
    stopStream();
  }
};

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

  const machineKey = getMachineKeyFromURL()
  if (machineKey == undefined) {
    throw new Error('Unable to find machine key for credentials')
  }

  const {
    apiKey,
    host
  } = getCredentialsFromCookie(machineKey)

machine = await VIAM.createRobotClient({
    host,
    credentials: {
      type: "api-key",
      payload: apiKey.key,
      authEntity: apiKey.id,
    },
    signalingAddress: "https://app.viam.com:443",
  });
  updateConnectionStatus(VIAM.MachineConnectionEvent.CONNECTED);
  machine.on('connectionstatechange', handleConnectionStateChange);

  const generic = new VIAM.GenericServiceClient(machine, 'sorter');

  try {
    camera = new VIAM.CameraClient(machine, "realsense-cam");
    startStream();

  } catch (error) {
    
  }

  startEl.addEventListener('click', async () => {
    initializeDetectionsView();

    const result = await generic.doCommand(
      Struct.fromJson({
        command: 'start'
      })
    );

    const vision = new VIAM.VisionClient(machine, 'detect-cubes');
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

    await machine.stopAll();
  });

  resetEl.addEventListener('click', async () => {
    isSearchingForObject = false
    const result = await generic.doCommand(
      Struct.fromJson({
        command: 'reset'
      })
    );
  });

  window.addEventListener("beforeunload", () => {
    stopStream();
    machine.disconnect();
  });
};

main();