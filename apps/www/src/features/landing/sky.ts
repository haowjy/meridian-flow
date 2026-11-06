import { MARKETING_SKY as C, type LinearRgb } from "@meridian/design-tokens/marketing-sky";

const vec3 = ([r, g, b]: LinearRgb) => `vec3(${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)})`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 R; uniform vec2 L;
uniform float T,ROT,TRAIL,DAWN,HOR,VEIL,ZOOM,LAMP,WIN,AU;
const float TAU=6.28318;
const vec3 SUN=${vec3(C.sun)};
float H(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p.yx+19.19);return fract((p.x+p.y)*p.x);}
vec3 stars(vec2 q,float N,float dens,float sz){
  float r=length(q);
  float ring=floor(r*N);
  float n=max(3.,floor(ring*.52));
  float a=fract((atan(q.y,q.x)+ROT)/TAU)*n;
  vec2 id=vec2(ring,floor(a));
  float h=H(id*.37+N);
  if(h<dens) return vec3(0.);
  float h2=H(id*.71+3.),h3=H(id*1.13+7.);
  float dr=(fract(r*N)-(.3+.4*h3))/N;
  float da=(fract(a)-(.25+.5*h2))/n*TAU*r;
  float tl=min(TRAIL*r,4.5/N);
  float dd=max(abs(da)-tl,0.);
  float b=exp(-(dr*dr+dd*dd)/(sz*sz));
  float tw=.8+.2*sin(T*(.6+h3*2.)+h*40.);
  vec3 c=mix(${vec3(C.starCool)},${vec3(C.starWarm)},h2);
  return c*b*tw*(.28+1.05*h3*h3);
}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*R)/R.y;
  uv=L+(uv-L)/ZOOM;
  float y=uv.y-HOR, sk=max(y,0.), d=max(-y,0.);
  vec3 lampc=${vec3(C.horizonGlow)};
  vec3 hz=${vec3(C.skyHaze)};
  vec3 col=mix(hz,${vec3(C.skyMid)},smoothstep(0.,.2,sk));
  col=mix(col,${vec3(C.skyTop)},smoothstep(.1,.8,sk));
  float side=exp(-abs(uv.x-L.x)*1.5);
  vec3 dawnc=mix(${vec3(C.dawnSky)},SUN*.46,exp(-sk*6.));
  dawnc=mix(dawnc,SUN*1.15,exp(-sk*16.)*side);
  col=mix(col,dawnc,DAWN);
  vec2 pole=vec2(L.x+.1,.72);
  vec2 q=uv-pole;
  vec3 st=stars(q,38.,.72,.0023)+stars(q,66.,.62,.0017)+stars(q,112.,.58,.0013);
  col+=st*(1.-DAWN*.92)*smoothstep(0.,.07,sk);
  float dl=length(vec2(max(abs(uv.x-L.x)-WIN,0.),uv.y-L.y));
  col+=lampc*(.00016/(dl*dl+.00006))*LAMP;
  { float x=uv.x*2.1;
    float wob=sin(x*1.25+T*.06)+.55*sin(x*2.7-T*.09+1.7)+.25*sin(x*6.1+T*.13);
    float y0=.2+.075*wob, e=sk-y0;
    float rays=.5+.5*sin(x*31.+3.*sin(x*5.3+T*.17)+T*.21);
    rays=mix(.45,1.,rays)*(.6+.4*sin(x*11.-T*.11+2.*wob));
    float a=smoothstep(-.012,.03,e)*exp(-max(e,0.)*3.1)*rays;
    float a2=smoothstep(-.02,.05,sk-y0*1.9-.1)*exp(-max(sk-y0*1.9-.1,0.)*4.)*(.5+.5*sin(x*19.+T*.15+wob*4.));
    vec3 ac=mix(${vec3(C.auroraLow)},${vec3(C.auroraHigh)},smoothstep(0.,.42,e));
    col+=(ac*a*.5+${vec3(C.auroraBand)}*a2*.16)*AU*(1.-DAWN);
  }
  col+=lampc*exp(-dl*5.)*.05*LAMP;
  float ln=smoothstep(.0011,.0,abs(uv.x-L.x))*smoothstep(0.,.03,sk)*smoothstep(1.1,.2,sk);
  col+=${vec3(C.meridianLine)}*ln*.14*(1.-DAWN*.6);
  col+=SUN*exp(-sk*40.)*exp(-abs(uv.x-L.x)*5.)*DAWN*.9*step(0.,y);
  if(y<0.){
    float z=1./(d+.016);
    vec2 w=vec2(uv.x*z*.8,z*.5);
    float rr=0.,f=1.;
    for(int i=0;i<4;i++){
      rr+=sin(w.x*f*6.+w.y*f*4.+T*(.5+f*.22)+sin(w.y*f*2.6+float(i)*1.7+T*.2))/f;
      f*=1.87;
    }
    vec3 sea=mix(hz*.5,${vec3(C.seaDeep)},smoothstep(0.,.3,d));
    sea=mix(sea,dawnc*.5+${vec3(C.dawnSeaLift)},DAWN*exp(-d*2.2));
    float px=max(abs(uv.x-L.x+rr*d*.055)-WIN,0.);
    float glit=.3+.7*smoothstep(.1,1.5,rr);
    sea+=lampc*exp(-abs(px)/(.004+d*.11))*glit*exp(-d*2.6)*LAMP*.62;
    float sg=smoothstep(.5,2.1,rr);sea+=${vec3(C.seaGlow)}*sg*sg*sg*exp(-d*3.2)*.34*AU*(1.-DAWN);
    sea+=SUN*exp(-abs(px)/(.03+d*.5))*glit*exp(-d*1.4)*DAWN*.85;
    col=sea;
  }
  col=mix(col,${vec3(C.veil)},VEIL);
  col+=(H(gl_FragCoord.xy*.01+fract(T))-.5)/150.;
  gl_FragColor=vec4(col,1.);
}`;

export type SkyFrame = {
  lampX: number;
  lampY: number;
  rotation: number;
  trail: number;
  dawn: number;
  horizon: number;
  veil: number;
  zoom: number;
  lamp: number;
  width: number;
  aurora: number;
};

const FLOAT_UNIFORMS = {
  ROT: "rotation",
  TRAIL: "trail",
  DAWN: "dawn",
  HOR: "horizon",
  VEIL: "veil",
  ZOOM: "zoom",
  LAMP: "lamp",
  WIN: "width",
  AU: "aurora",
} as const;

export type Sky = ReturnType<typeof createSky>;

/** Draws into `canvas`. Without WebGL every call is a no-op and the canvas's CSS gradient shows. */
export function createSky(canvas: HTMLCanvasElement, signal: AbortSignal) {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    powerPreference: "low-power",
  });
  let uniforms = gl ? connect(gl) : null;
  let resolution = 0.8;
  let onRestored = () => {};

  // A phone can discard a background tab's context. Without preventDefault it never returns.
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      uniforms = null;
    },
    { signal },
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      if (!gl) return;
      uniforms = connect(gl);
      gl.viewport(0, 0, canvas.width, canvas.height);
      onRestored();
    },
    { signal },
  );

  const resize = () => {
    if (!gl || !uniforms) return;
    const scale = Math.min(devicePixelRatio || 1, 1.5) * resolution;
    const width = Math.round(innerWidth * scale);
    const height = Math.round(innerHeight * scale);
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  };

  return {
    resize,
    /** Called when frames run slow: the sky stays smooth by drawing fewer pixels. */
    lowerResolution() {
      if (resolution <= 0.45) return;
      resolution = Math.max(0.45, resolution - 0.1);
      resize();
    },
    /** For a static sky, which has no next frame to redraw it. */
    onRestored(callback: () => void) {
      onRestored = callback;
    },
    draw(frame: SkyFrame, time: number) {
      if (!gl || !uniforms) return;
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
      gl.uniform2f(uniforms.lamp, frame.lampX, frame.lampY);
      gl.uniform1f(uniforms.time, time);
      for (const [location, key] of uniforms.floats) gl.uniform1f(location, frame[key]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

function connect(gl: WebGLRenderingContext) {
  const program = linkProgram(gl);
  if (!program) return null;
  const location = (name: string) => gl.getUniformLocation(program, name);
  return {
    size: location("R"),
    lamp: location("L"),
    time: location("T"),
    floats: Object.entries(FLOAT_UNIFORMS).map(([name, key]) => [location(name), key] as const),
  };
}

function linkProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}"),
  );
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  return program;
}
