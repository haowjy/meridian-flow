import { MARKETING_SKY as C, type LinearRgb } from "@meridian/design-tokens/marketing-sky";

const vec3 = ([r, g, b]: LinearRgb) => `vec3(${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)})`;

/** Where the dragon's peak stands: its compass angle from the opening view, and its height. */
export const SUMMIT = { azimuth: 0.6, elevation: 0.2 };

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
float field(vec2 p){
  vec2 w=vec2(N(p*.45+vec2(FLOW*.1,0.)),N(p*.45+vec2(4.,-FLOW*.08)))-.5;
  vec2 q=p+w*3.2;
  float n=1.-abs(2.*fbm(q+vec2(FLOW*.03,-FLOW*.02))-1.);
  n=max(pow(n,8.)-.05,0.)*1.5;
  float cover=max(smoothstep(.4,.58,N(p*.13+vec2(FLOW*.015,3.))),smoothstep(3.,1.,length(p)));
  return n*cover*(.45+.55*N(q*9.+FLOW*.25));
}
vec3 aurora(vec3 rd){
  if(rd.y<.015) return vec3(0.);
  vec3 a=vec3(0.);
  float j=H(gl_FragCoord.xy*.013);
  for(int i=0;i<14;i++){
    float k=float(i)*1.57;
    float t=(1.+(k+j*1.57)*.075)/rd.y;
    float f=field(rd.xz*min(t,16.)*1.1);
    vec3 c=mix(${vec3(C.auroraLow)},${vec3(C.auroraMid)},smoothstep(0.,8.,k));
    c=mix(c,${vec3(C.auroraHigh)},smoothstep(8.,21.,k));
    a+=c*f*exp(-k*.1);
  }
  return a*.31*smoothstep(.015,.2,rd.y);
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
uniform float DAWN,VEIL,AU,PLUME;
uniform vec3 DRIFT;
const float AZ=${SUMMIT.azimuth.toFixed(3)};
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
// The Cold Fire low in the north: a wide band of curtains standing behind the far range, densest
// around the dragon's peak and fading upward into the sheet. It is there every night.
float behind(float az,float y){
  float h=max(y-farRange(az)*.7,0.);
  float b=(az-AZ)/.55;
  float curtains=.45+.55*N(vec2(az*38.+FLOW*.2,y*2.-FLOW*.3));
  return exp(-b*b)*exp(-h*5.)*smoothstep(0.,.04,h)*curtains;
}
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
  light=(light+${vec3(C.auroraCore)}*l*l*l*1.4)*AU*night;
  vec3 sky=mix(${vec3(C.skyHorizon)},${vec3(C.skyTop)},smoothstep(0.,.5,abs(y)));
  vec3 dawn=mix(lin(${vec3(C.dawnSky)}),${vec3(C.sun)}*.5,exp(-max(y,0.)*7.));
  dawn=mix(dawn,${vec3(C.sun)}*1.2,exp(-max(y,0.)*18.)*exp(-abs(az-AZ+.2)*2.));
  sky=mix(sky,dawn,DAWN);
  vec3 col;
  if(y>=0.){
    col=sky+stars(rd)*night+light+${vec3(C.auroraLow)}*.008*exp(-y*6.)*AU*night;
    float rising=behind(az,y)*PLUME*night;
    col+=(${vec3(C.auroraMid)}*.5+${vec3(C.auroraCore)}*rising*.6)*rising;
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
};

const CAMERA_UNIFORMS = { PITCH: "pitch", YAW: "yaw", FOCAL: "focal", FLOW: "flow" } as const;
const SCENE_UNIFORMS = { DAWN: "dawn", VEIL: "veil", PLUME: "plume" } as const;

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
    if (!gl || !scene) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.lightTarget);
    camera(gl, scene.lightPass, frame, scene.lightWidth, scene.lightHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    drawScene(frame, seconds);
  };

  const drawScene = (frame: SkyFrame, seconds: number) => {
    if (!gl || !scene) return;
    camera(gl, scene.scenePass, frame, canvas.width, canvas.height);
    for (const [location, key] of scene.floats) gl.uniform1f(location, frame[key]);
    const wave = Math.sin(seconds * 0.9) * 0.65 + Math.sin(seconds * 2.3 + 1) * 0.35;
    gl.uniform1f(scene.pulsedAurora, frame.aurora * (1 + frame.pulse * 0.28 * wave));
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
    /** One still-page frame: reuses the aurora pass, so the pulse costs only the scene pass. */
    breathe(seconds: number) {
      if (!lastFrame?.pulse || seconds - lastBreath < 1 / 30) return;
      lastBreath = seconds;
      drawScene(lastFrame, seconds);
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

function connect(gl: WebGLRenderingContext) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const lightPass = pass(gl, LIGHT_SHADER);
  const scenePass = pass(gl, SCENE_SHADER);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

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
