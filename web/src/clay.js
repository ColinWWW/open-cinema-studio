// The grey "clay" world: floor, sky, sun, primitives and the shot camera.
// Shading matches scripts/make_test_layout.py: value = grey * (0.45 + 0.55 * lambert * lit),
// with colour management off so greys go to the screen untouched.
import * as THREE from 'three';

THREE.ColorManagement.enabled = false;

const LIGHT_DIR = new THREE.Vector3(0.45, 0.8, -0.4).normalize(); // mirror of the Python LIGHT
const FLOOR_GREY = 0.62;
const SKY_GREY = 0.8;

export function createRenderer(canvas, { preserveDrawingBuffer = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/** Perspective camera with a vertical lens shift (architectural "rise"): 0 puts the horizon mid-frame. */
export class ShiftCamera extends THREE.PerspectiveCamera {
  updateProjectionMatrix() {
    super.updateProjectionMatrix();
    if (this.lensShift) {
      this.projectionMatrix.elements[9] = this.lensShift;
      this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    }
  }
}

const GEOMETRY = {
  box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  person: new THREE.CapsuleGeometry(0.25, 1.25, 4, 16).translate(0, 0.875, 0), // 1.75 m tall
  plane: new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
};
export const PRIMITIVES = Object.keys(GEOMETRY);

function makeSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float v = 0.80 + 0.12 * clamp(normalize(vDir).y, 0.0, 1.0);
        gl_FragColor = vec4(vec3(v), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.onBeforeRender = (_r, _s, camera) => sky.position.copy(camera.position);
  return sky;
}

export class ClayWorld {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(SKY_GREY, SKY_GREY, SKY_GREY), 8, 38);
    this.scene.add(makeSky());

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(FLOOR_GREY, FLOOR_GREY, FLOOR_GREY) }),
    );
    floor.receiveShadow = true;
    floor.userData.isFloor = true;
    this.floor = floor;
    this.scene.add(floor);

    // Lambert divides by pi, so pi * (0.45, 0.55) gives the Python script's 0.45 ambient + 0.55 sun.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45 * Math.PI));
    this.sun = new THREE.DirectionalLight(0xffffff, 0.55 * Math.PI);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.objects = new THREE.Group();
    this.scene.add(this.objects);
    this.meshes = new Map(); // id -> mesh

    this.helpers = new THREE.Group(); // editor-only: hidden in shot renders
    this.scene.add(this.helpers);

    this.shotCam = new ShiftCamera(45, 5 / 3, 0.05, 5000);
    this.shotCam.lensShift = 0;
  }

  setFog([near, far]) {
    this.scene.fog.near = near;
    this.scene.fog.far = far;
  }

  /** Create, update and remove meshes so they match the scene's object list. */
  syncObjects(list) {
    const seen = new Set();
    for (const obj of list) {
      seen.add(obj.id);
      let mesh = this.meshes.get(obj.id);
      if (!mesh || mesh.userData.type !== obj.type) {
        if (mesh) this.objects.remove(mesh);
        mesh = new THREE.Mesh(
          GEOMETRY[obj.type],
          new THREE.MeshLambertMaterial({ side: obj.type === 'plane' ? THREE.DoubleSide : THREE.FrontSide }),
        );
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData = { id: obj.id, type: obj.type };
        this.meshes.set(obj.id, mesh);
        this.objects.add(mesh);
      }
      this.applyObject(mesh, obj);
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        this.objects.remove(mesh);
        mesh.material.dispose();
        this.meshes.delete(id);
      }
    }
    this.fitShadow();
  }

  applyObject(mesh, obj) {
    mesh.position.fromArray(obj.position);
    mesh.rotation.set(...obj.rotation);
    mesh.scale.fromArray(obj.scale);
    mesh.material.color.setRGB(obj.grey, obj.grey, obj.grey);
  }

  /** Point the sun's shadow camera at the objects' bounding sphere. */
  fitShadow() {
    const box = new THREE.Box3();
    for (const mesh of this.meshes.values()) box.expandByObject(mesh);
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 10) : box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 5) * 1.1;
    this.sun.target.position.copy(sphere.center);
    this.sun.position.copy(sphere.center).addScaledVector(LIGHT_DIR, r * 2);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.1;
    cam.far = r * 4;
    cam.updateProjectionMatrix();
  }

  /** Set the shot camera from the scene's camera settings and a pose from cameraPath.poseAt. */
  applyShot(cameraSettings, pose, aspect) {
    const cam = this.shotCam;
    cam.fov = cameraSettings.fov;
    cam.lensShift = cameraSettings.lensShift || 0;
    cam.aspect = aspect;
    if (pose) {
      cam.position.fromArray(pose.position);
      cam.up.set(0, 1, 0);
      cam.lookAt(new THREE.Vector3().fromArray(pose.target));
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
