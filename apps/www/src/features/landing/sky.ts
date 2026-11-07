import { MARKETING_SKY as C, type LinearRgb } from "@meridian/design-tokens/marketing-sky";
import {
  across,
  type BeatProgress,
  coldFireLeft,
  DEATH,
  ease,
  envelope,
  FIGHT,
  lerp,
  smooth,
  TURN,
  tilt,
} from "./timeline";

/** A sky colour as a GLSL literal, and as a CSS colour for the layers drawn over the sky. */
export const vec3 = ([r, g, b]: LinearRgb) =>
  `vec3(${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)})`;
// Written as they are. That matches the fire shader, which uses fireBody and fireCore unencoded;
// sun and auroraMid are linear in the sky shader, so their CSS copies read a little darker.
export const rgb = ([r, g, b]: LinearRgb) => `rgb(${r * 255} ${g * 255} ${b * 255})`;

/** The dragon's peak: its compass angle from the opening view. */
const SUMMIT_AZIMUTH = 0.6;
/** Where the level view looks: its compass angle from the opening view. */
const HORIZON_YAW = 0.34;

/** How fast the aurora waves on its own, in flow per second, scrolled or not. */
const WAVE = 1.1;

/** How much smaller the aurora pass is than the canvas, per side. It is soft, so this barely shows. */
const LIGHT_DIVISOR = 3;

export const NOISE = `
// Integer arithmetic: a float hash rounds differently per GPU and tears the noise at cell edges.
float G(vec2 i){i=mod(i,289.);float a=mod((i.x*34.+1.)*i.x+i.y,289.);a=mod((a*34.+1.)*a+i.y,289.);return fract(a*.02439);}
float N(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(G(i),G(i+vec2(1,0)),f.x),mix(G(i+vec2(0,1)),G(i+vec2(1,1)),f.x),f.y);
}`;

const SHARED = `
precision highp float;
uniform vec2 R;
uniform float PITCH,YAW,FOCAL,FLOW;
${NOISE}
vec3 ray(){
  vec2 uv=(gl_FragCoord.xy-.5*R)/R.y;
  vec3 fw=vec3(sin(YAW)*cos(PITCH),sin(PITCH),-cos(YAW)*cos(PITCH));
  vec3 rt=normalize(cross(fw,vec3(0.,1.,.001)));
  return normalize(uv.x*rt+uv.y*cross(rt,fw)+FOCAL*fw);
}
float ripple(vec3 rd){
  float z=1./(-rd.y+.02);
  return (N(vec2(rd.x*z*5.,z*1.6+FLOW*.25))-.5)*2.+(N(vec2(rd.x*z*14.,z*4.-FLOW*.4))-.5);
}`;

// A horizontal sheet sliced at rising heights: seen overhead it curls, seen far away its rays hang
// as curtains, and both come from the same field.
const LIGHT_SHADER = `${SHARED}
float H(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}
float fbm(vec2 p){return .6*N(p)+.3*N(p*2.1+5.)+.1*N(p*4.3+9.);}
const float AZ=${SUMMIT_AZIMUTH.toFixed(3)};
const float HY=${HORIZON_YAW.toFixed(3)};
// SETTLED is the flow without the clock: where the aurora lies follows the scroll alone, so time
// away from the page can't drift it all into a gap.
uniform float PLUME,SETTLED;
// Down the middle of the level view, so the peak on the right stands clear of it.
const float AHEAD=${HORIZON_YAW.toFixed(3)};
float field(vec2 p,float fire,out float band){
  vec2 w=vec2(N(p*.45+vec2(FLOW*.1,0.)),N(p*.45+vec2(4.,-FLOW*.08)))-.5;
  vec2 q=p+w*3.2;
  float n=1.-abs(2.*fbm(q+vec2(FLOW*.03,-FLOW*.02))-1.);
  n=max(pow(n,8.)-.05,0.)*1.5;
  float cover=smoothstep(.4,.58,N(p*.13+vec2(SETTLED*.015,3.)));
  // Where the Cold Fire is strong the sheet's gaps fill in.
  cover=max(cover,min(fire*.3,.5));
  // It thins with distance, as the real ones do: far off a few arcs, not a lit horizon.
  float sheet=n*cover*(.45+.55*N(q*9.+FLOW*.25))*max(smoothstep(22.,4.,length(p)),min(fire,1.));
  // One great curtain from straight overhead away down the middle of the level view: thin from
  // below, folding side to side by a small angle so it keeps its line, and raked with fine rays,
  // which the slices stand up into a curtain. Looking up it crosses the sky; looking out it
  // narrows into the distance.
  // The sheet is sampled mirrored, so its heading is too.
  vec2 ahead=vec2(-sin(AHEAD),-cos(AHEAD));
  float along=dot(p,ahead);
  float fold=.1*sin(along*.45+FLOW*.07)+.05*sin(along*1.2-FLOW*.05);
  float off=dot(p,vec2(-ahead.y,ahead.x))-(max(along,0.)+.6)*fold;
  float curtain=(exp(-off*off*36.)+.45*exp(-(off-.35)*(off-.35)*60.))*smoothstep(-4.,0.,along);
  float rays=.2+.8*pow(N(vec2(along*7.-FLOW*.35,off*3.)),2.5);
  band=curtain*rays;
  return sheet;
}
// Over the dragon's peak, low in the north, the same ribbons burn brighter: the Cold Fire, which
// swells on each gulp.
vec3 aurora(vec3 rd){
  if(rd.y<.006) return vec3(0.);
  vec3 a=vec3(0.);
  float az=atan(rd.x,-rd.z);
  float b=(az-AZ)/.4;
  float fire=exp(-b*b)*exp(-rd.y*3.)*PLUME;
  // The low sky right of the middle belongs to the peak and the great curtain: the sheet thins
  // there, until the stirred Cold Fire fills it back in.
  float spare=max(1.-.75*smoothstep(HY,HY+.3,az)*smoothstep(.55,.12,rd.y),min(fire*.4,1.));
  float j=H(gl_FragCoord.xy*.013);
  for(int i=0;i<14;i++){
    float k=float(i)*1.57;
    float t=(1.+(k+j*1.57)*.075)/rd.y;
    // Far enough that the ribbons keep receding to the horizon instead of piling up into haze.
    vec2 at=rd.xz*min(t,44.)*1.1;
    float band;
    // Mirrored, so its heaviest curtains fall on the right, away from the text.
    float f=field(vec2(-at.x,at.y),fire,band);
    vec3 c=mix(${vec3(C.auroraLow)},${vec3(C.auroraMid)},smoothstep(0.,8.,k));
    // Green low down; the rays turn purple toward their tops, and here and there lean blue.
    float blue=smoothstep(.55,.8,N(at*.07+vec2(11.,FLOW*.012)));
    c=mix(c,${vec3(C.auroraBlue)},blue*.3);
    c=mix(c,${vec3(C.auroraHigh)},smoothstep(5.,17.,k));
    a+=c*f*spare*exp(-k*.075);
    // The great curtain hangs from a bright green hem; its rays fade fast above it.
    a+=mix(${vec3(C.auroraLow)},c,smoothstep(0.,6.,k))*band*(2.2*exp(-k*.35)+.12);
  }
  return a*.31*(1.+min(fire,1.6)*.5)*smoothstep(.006,.05,rd.y);
}
void main(){
  vec3 rd=ray(),c;
  if(rd.y>=0.) c=aurora(rd);
  else{
    float d=-rd.y;
    c=aurora(normalize(vec3(rd.x+ripple(rd)*d*.07,d,rd.z)))*.32*exp(-d*1.4);
  }
  gl_FragColor=vec4(sqrt(c/(1.+c)),1.);
}`;

const SCENE_SHADER = `${SHARED}
uniform sampler2D LIGHT;
uniform float DAWN,VEIL,AU;
uniform vec3 DRIFT;
const float AZ=${SUMMIT_AZIMUTH.toFixed(3)};
float H(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}
vec3 lin(vec3 c){return pow(c,vec3(2.2));}
float ridged(float x,float s){return 1.-abs(2.*N(vec2(x,s))-1.);}
float peaks(float z,float s,float k,float h){
  float n=ridged(z*k+s,s);
  n=n*n*.62+ridged(z*k*2.3+s,s+2.)*.24+ridged(z*k*5.7,s+4.)*.1+ridged(z*k*14.,s+6.)*.04;
  return n*h*smoothstep(.1,.5,abs(z-.05))+.008;
}
float farRange(float z){float b=(z-AZ)/.09;return peaks(z,3.1,3.,.17)+.1*exp(-b*b);}
float nearRange(float z){return peaks(z,7.4,2.,.11);}
vec3 stars(vec3 d){
  vec2 s=vec2(atan(d.x,-d.z),d.y)*56.;
  vec2 i=floor(s),f=fract(s)-.5;
  if(G(i+1.)<.72) return vec3(0.);
  vec2 o=(vec2(G(i+7.),G(i+13.))-.5)*.7;
  return ${vec3(C.star)}*smoothstep(.13/max(FOCAL,1.),0.,length(f-o))*(.3+.9*G(i+3.))*smoothstep(0.,.08,d.y);
}
void main(){
  vec3 rd=ray();
  float az=atan(rd.x,-rd.z),y=rd.y;
  float night=1.-DAWN;
  vec2 p=.5+(gl_FragCoord.xy/R-.5)*DRIFT.z+DRIFT.xy,t=2.4/R*${LIGHT_DIVISOR}.*.5;
  vec3 e=texture2D(LIGHT,p).rgb*.2;
  for(int i=0;i<4;i++){
    vec2 s=vec2(i<2?1.:-1.,mod(float(i),2.)<1.?1.:-1.);
    e+=texture2D(LIGHT,p+s*t).rgb*.2;
  }
  e*=e;
  vec3 light=e/max(1.-e,.001);
  float l=max(light.g,light.b);
  light*=smoothstep(.012,.22,l);
  light=(light+${vec3(C.auroraCore)}*l*l*l*.5)*AU*night;
  vec3 sky=mix(${vec3(C.skyHorizon)},${vec3(C.skyTop)},smoothstep(0.,.5,abs(y)));
  vec3 dawn=mix(lin(${vec3(C.dawnSky)}),${vec3(C.sun)}*.5,exp(-max(y,0.)*7.));
  dawn=mix(dawn,${vec3(C.sun)}*1.2,exp(-max(y,0.)*18.)*exp(-abs(az-AZ+.2)*2.));
  sky=mix(sky,dawn,DAWN);
  vec3 col;
  if(y>=0.){
    col=sky+stars(rd)*night+light+${vec3(C.auroraLow)}*.008*exp(-y*6.)*AU*night;
    float far=farRange(az),near=nearRange(az);
    vec3 lit=${vec3(C.sun)}*.04*DAWN;
    if(y<far) col=mix(col,${vec3(C.mountain)}*1.6+lit,smoothstep(far,far-.002,y));
    if(y<near) col=mix(col,${vec3(C.mountain)}*.5+lit*.3,smoothstep(near,near-.002,y));
  }else{
    float d=-y,r=ripple(rd);
    vec3 sea=mix(${vec3(C.sea)},sky*.55,DAWN)+light;
    float mirror=az+r*d*.03;
    sea*=mix(.25,1.,smoothstep(-.01,.01,d-farRange(mirror)*.95));
    col=sea;
  }
  col=col/(1.+col*.35);
  col+=(H(gl_FragCoord.xy*.01)-.5)/150.;
  gl_FragColor=vec4(mix(pow(max(col,0.),vec3(.4545)),${vec3(C.veil)},VEIL),1.);
}`;

export type SkyFrame = {
  pitch: number;
  yaw: number;
  focal: number;
  flow: number;
  dawn: number;
  veil: number;
  aurora: number;
  /** The band of Cold Fire behind the far range, 0 (none) and up. */
  plume: number;
  /** How strongly the aurora breathes while the page is still, 0 to 1. */
  pulse: number;
  /** How hard each gulp of Cold Fire the perched dragon sends up swells the aurora, 0 and up. */
  surge: number;
};

const GULP_SECONDS = 1.1;
/** The share of a gulp spent rising from the mouth; then it reaches the sky. */
export const GULP_RISE = 0.45;
/** 0 to 1 through each gulp: it leaves the mouth at 0 and reaches the sky at `GULP_RISE`. */
export const gulpPhase = (seconds: number) => (seconds / GULP_SECONDS) % 1;
/** The aurora's swell from the last gulp to reach it, 1 on arrival and decaying. */
const gulpSwell = (seconds: number) => {
  const since = (gulpPhase(seconds) - GULP_RISE + 1) % 1;
  return Math.exp(-since * 3);
};

const OVERHEAD_PITCH = 0.8;
const HORIZON_PITCH = 0.1;

/**
 * The sky at a scroll position, `scrolled` in stage heights. It is a function of the scroll
 * position, so it holds still when the page does.
 */
export function skyFrame(beats: BeatProgress, scrolled: number): SkyFrame {
  const tipped = tilt(beats);
  // The fire uncovers a finished dawn, so the sky is already there behind it.
  const revealed = beats.burn >= DEATH.reveals;
  // Tam's spark in its eye: the Cold Fire flickers and for a moment the sun shows through.
  const hurt = envelope(beats.fight, [FIGHT.spark.eye[1], FIGHT.spark.eye[1] + 0.09], 0.02, 0.06);
  const dawn = revealed ? 1 : Math.max(ease(beats.dawn), hurt * 0.4);
  // From the perch on, the Cold Fire it sent up stays in the sky and pulses until the box burns.
  const stirred = smooth(beats.turn, TURN.perch[0], TURN.perch[0] + 0.06) * coldFireLeft(beats);
  // Every breath it takes goes up green: the Cold Fire swells and churns while they fight.
  const breathing =
    stirred * 0.5 +
    smooth(beats.fight, 0, 0.08) * 0.2 +
    envelope(beats.fight, FIGHT.ward, 0.04, 0.06) * 0.45 +
    envelope(beats.fight, FIGHT.breath, 0.04, 0.06) * 0.7;
  let veil = lerp(0, 0.36, smooth(beats.sky, 0.88, 1));
  // The veil keeps the chapter readable; once its text fades the perch and the fight are the
  // picture, so it lifts.
  const lifted = smooth(beats.turn, TURN.perch[0] - 0.08, TURN.perch[0] + 0.04);
  veil = lerp(veil, 0.06, lifted);
  veil = lerp(veil, 0.2, smooth(across(beats, "dies", "burn"), 0, 0.625));
  veil = lerp(veil, 0, dawn);
  return {
    pitch: lerp(OVERHEAD_PITCH, HORIZON_PITCH, tipped),
    yaw: HORIZON_YAW * tipped * tipped,
    focal: lerp(0.62, 0.9, tipped),
    flow:
      scrolled * 0.4 +
      ease(beats.push) * 2 +
      ease(beats.sky) * 1.5 +
      smooth(across(beats, "dies", "burn"), 0, 0.85) * 5 +
      ease(beats.fight) * 4 +
      dawn * 1.5,
    dawn,
    veil,
    aurora:
      lerp(0.72, 0.6, smooth(beats.sky, 0.7, 1)) +
      smooth(across(beats, "dies", "burn"), 0.0375, 0.5875) *
        (1 - smooth(beats.burn, 0.55, 1)) *
        0.5 +
      breathing * coldFireLeft(beats),
    // Low in the north over the dragon's peak every night; what it sends up from the perch stays
    // there, brighter, until the box burns.
    plume: (0.9 + stirred * 1.4) * coldFireLeft(beats),
    surge: stirred,
    pulse: Math.max(
      1 - smooth(beats.push, 0, 0.35),
      smooth(beats.sky, 0.3, 0.42) * (1 - smooth(beats.sky, 0.72, 0.85)),
      revealed ? 0 : smooth(beats.flight, 0.11, 0.94),
    ),
  };
}

/** Reduced motion: one still night over the stacked page. */
export const STILL_SKY: SkyFrame = {
  pitch: HORIZON_PITCH,
  yaw: HORIZON_YAW,
  focal: 0.9,
  flow: 3,
  dawn: 0,
  veil: 0.12,
  aurora: 1,
  pulse: 0,
  surge: 0,
  plume: 0.5,
};

const CAMERA_UNIFORMS = { PITCH: "pitch", YAW: "yaw", FOCAL: "focal", FLOW: "flow" } as const;
const SCENE_UNIFORMS = { DAWN: "dawn", VEIL: "veil" } as const;

/** Draws into `canvas`. Without WebGL every call is a no-op and the canvas's CSS gradient shows. */
export function createSky(canvas: HTMLCanvasElement, signal: AbortSignal) {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    powerPreference: "low-power",
  });
  let scene = gl ? connect(gl) : null;
  let resolution = 0.8;
  let lastFrame: SkyFrame | null = null;
  let lastBreath = 0;

  const sizeLight = () => {
    if (!gl || !scene) return;
    scene.lightWidth = Math.max(1, Math.round(canvas.width / LIGHT_DIVISOR));
    scene.lightHeight = Math.max(1, Math.round(canvas.height / LIGHT_DIVISOR));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.light);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      scene.lightWidth,
      scene.lightHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  };

  // A phone can discard a background tab's context. Without preventDefault it never returns.
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      scene = null;
    },
    { signal },
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      if (!gl) return;
      scene = connect(gl);
      sizeLight();
      if (lastFrame) draw(lastFrame, 0);
    },
    { signal },
  );

  const resize = () => {
    if (!gl || !scene) return;
    const scale = Math.min(devicePixelRatio || 1, 1.5) * resolution;
    const width = Math.round(innerWidth * scale);
    const height = Math.round(innerHeight * scale);
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    sizeLight();
  };

  const draw = (frame: SkyFrame, seconds: number) => {
    lastFrame = frame;
    lastBreath = seconds;
    if (!gl || !scene) return;
    const waving = { ...frame, flow: frame.flow + seconds * WAVE };
    // In full day the scene multiplies the aurora by zero: skip its pass, the heaviest one.
    if (frame.dawn < 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.lightTarget);
      camera(gl, scene.lightPass, waving, scene.lightWidth, scene.lightHeight);
      gl.uniform1f(scene.plume, frame.plume + frame.surge * gulpSwell(seconds) * 1.6);
      gl.uniform1f(scene.settled, frame.flow);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    drawScene(waving, seconds);
  };

  const drawScene = (frame: SkyFrame, seconds: number) => {
    if (!gl || !scene) return;
    camera(gl, scene.scenePass, frame, canvas.width, canvas.height);
    const swell = frame.surge * gulpSwell(seconds);
    for (const [location, key] of scene.floats) gl.uniform1f(location, frame[key]);
    const wave = Math.sin(seconds * 0.9) * 0.65 + Math.sin(seconds * 2.3 + 1) * 0.35;
    gl.uniform1f(scene.pulsedAurora, frame.aurora * (1 + frame.pulse * 0.28 * wave) + swell * 2.2);
    // The aurora zooms in as it drifts, or the drift would pull its clamped edge into view.
    gl.uniform3f(
      scene.drift,
      Math.sin(seconds * 0.31) * 0.012 * frame.pulse,
      Math.cos(seconds * 0.23) * 0.008 * frame.pulse,
      1 - 0.03 * frame.pulse,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    resize,
    draw,
    /** A frame while the page is still: the aurora keeps waving, at up to 30 frames a second. */
    breathe(seconds: number) {
      if (!lastFrame || seconds - lastBreath < 1 / 30) return;
      draw(lastFrame, seconds);
    },
    /** Called when frames run slow: the sky stays smooth by drawing fewer pixels. */
    lowerResolution() {
      if (resolution <= 0.45) return false;
      resolution = Math.max(0.45, resolution - 0.1);
      resize();
      return true;
    },
  };
}

type Pass = ReturnType<typeof pass>;

function camera(
  gl: WebGLRenderingContext,
  target: Pass,
  frame: SkyFrame,
  width: number,
  height: number,
) {
  gl.useProgram(target.program);
  gl.viewport(0, 0, width, height);
  gl.uniform2f(target.size, width, height);
  for (const [location, key] of target.camera) gl.uniform1f(location, frame[key]);
}

function pass(gl: WebGLRenderingContext, source: string) {
  const program = linkProgram(gl, source);
  const camera = Object.entries(CAMERA_UNIFORMS).map(
    ([name, key]) => [gl.getUniformLocation(program, name), key] as const,
  );
  return { program, size: gl.getUniformLocation(program, "R"), camera };
}

function texture(gl: WebGLRenderingContext) {
  const handle = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return handle;
}

/** One triangle that covers the canvas, at attribute 0: every pass draws the whole frame. */
export function coverCanvas(gl: WebGLRenderingContext) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

function connect(gl: WebGLRenderingContext) {
  coverCanvas(gl);
  const lightPass = pass(gl, LIGHT_SHADER);
  const scenePass = pass(gl, SCENE_SHADER);

  const light = texture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const lightTarget = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, lightTarget);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, light, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  gl.useProgram(scenePass.program);
  gl.uniform1i(gl.getUniformLocation(scenePass.program, "LIGHT"), 0);
  const floats = Object.entries(SCENE_UNIFORMS).map(
    ([name, key]) => [gl.getUniformLocation(scenePass.program, name), key] as const,
  );
  return {
    lightPass,
    scenePass,
    floats,
    pulsedAurora: gl.getUniformLocation(scenePass.program, "AU"),
    plume: gl.getUniformLocation(lightPass.program, "PLUME"),
    settled: gl.getUniformLocation(lightPass.program, "SETTLED"),
    drift: gl.getUniformLocation(scenePass.program, "DRIFT"),
    light,
    lightTarget,
    lightWidth: 1,
    lightHeight: 1,
  };
}

export function linkProgram(gl: WebGLRenderingContext, source: string) {
  const compile = (type: number, text: string) => {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram() as WebGLProgram;
  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}"),
  );
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source));
  gl.bindAttribLocation(program, 0, "a");
  gl.linkProgram(program);
  return program;
}
