import { MARKETING_SKY as C, type LinearRgb } from "@meridian/design-tokens/marketing-sky";
import { linkProgram, NOISE } from "./sky";

const vec3 = ([r, g, b]: LinearRgb) => `vec3(${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)})`;

export type FireFrame = {
  /** Where the jet starts and where it points, in stage pixels from the top left. */
  mouth: readonly [number, number];
  aim: readonly [number, number];
  /** 0 is no jet, 1 is full breath. */
  breath: number;
  /** How far right the fire has burnt, in stage heights. */
  char: number;
  time: number;
};

const FIRE_SHADER = `precision highp float;
uniform vec2 R,MOUTH,AIM;
uniform float BREATH,CHAR,T;
uniform sampler2D NIGHT,WORDS;
${NOISE}
float fbm(vec2 p){return .55*N(p)+.3*N(p*2.1+5.)+.15*N(p*4.3+9.);}
// Heat to light: blue-white heart, green body, deep green falling off to nothing.
vec3 flame(float h){
  vec3 c=mix(${vec3(C.fireDeep)},${vec3(C.fireBody)},smoothstep(.12,.5,h));
  c=mix(c,${vec3(C.fireHeart)},smoothstep(.55,.85,h));
  return mix(c,${vec3(C.fireCore)},smoothstep(.85,1.,h));
}
// Premultiplied: a over b.
vec4 over(vec4 a,vec4 b){return a+b*(1.-a.a);}
void main(){
  vec2 p=vec2(gl_FragCoord.x,R.y-gl_FragCoord.y)/R.y;
  vec4 out_c=vec4(0.);

  float warp=fbm(p*2.6+vec2(3.,T*.05))*.62+fbm(p*9.)*.14;
  // A wall of fire moving right, leading at the height of the breath.
  float wall=p.x+(warp-.4)*.5+abs(p.y-.5)*.34;
  float d=CHAR-wall;
  if(d<0.){
    vec2 uv=vec2(p.x*R.y/R.x,p.y);
    out_c=vec4(texture2D(NIGHT,uv).rgb,1.);
    // Letters heat as the wall nears: orange, then char, then holes eat through them.
    vec4 ink=texture2D(WORDS,uv);
    float crumble=fbm(p*38.)*.5+fbm(p*90.)*.3;
    float heat=smoothstep(.26,.0,-d+(crumble-.4)*.16);
    vec3 hot=mix(ink.rgb,${vec3(C.fireEdge)}*1.2,smoothstep(.15,.55,heat));
    hot=mix(hot,${vec3(C.fireChar)},smoothstep(.6,.85,heat));
    float left=ink.a*(1.-smoothstep(.7,.95,heat));
    out_c.rgb=mix(out_c.rgb,hot,left);
  }else{
    // A rim of char behind the fire, with bright veins, then nothing: what it burnt is gone.
    float rim=smoothstep(.17,.03,d+(fbm(p*11.)-.5)*.13);
    vec3 ash=${vec3(C.fireChar)}*(.5+fbm(p*34.));
    float vein=1.-abs(fbm(p*24.+7.)*2.-1.);
    ash+=${vec3(C.fireEdge)}*pow(vein,70.)*1.6;
    out_c=vec4(ash*rim,rim);
  }
  // A hairline of orange, then thin green tongues with a hot root.
  float band=.035+.11*fbm(vec2(p.x*4.,p.y*4.+T*.6));
  float lick=fbm(vec2(p.x*27.,p.y*10.+T*3.2))*1.1+fbm(vec2(p.x*64.,p.y*25.+T*5.))*.5;
  float flare=(1.-abs(d)/band)*1.3-(1.-lick)*1.05;
  float flareA=smoothstep(.02,.34,flare);
  float glow=exp(-d*d*70.)*.14;
  out_c=over(vec4(${vec3(C.fireBody)}*glow,glow*.5),out_c);
  // The grain keeps the colours from sitting in clean bands along the edge.
  float grain=fbm(vec2(p.x*38.,p.y*17.+T*4.));
  out_c=over(vec4(flame(flare*(.45+grain*.95))*flareA,flareA),out_c);
  float line=exp(-d*d*16000.)*smoothstep(.3,.55,fbm(p*13.+vec2(0.,T)));
  out_c=over(vec4(${vec3(C.fireEdge)}*line*1.2,line),out_c);

  if(BREATH>0.){
    vec2 d=AIM-MOUTH;float len=length(d);d/=len;
    vec2 q=p-MOUTH;
    float s=dot(q,d)/len;
    float t=dot(q,vec2(-d.y,d.x));
    if(s>-.04&&s<1.15){
      float at=s*len;
      t+=(fbm(vec2(at*5.-T*5.,T*.7))-.5)*.2*smoothstep(0.,.8,s);
      float wide=.012+.13*pow(max(s,0.),.75);
      float across=abs(t)/wide;
      float tear=fbm(vec2(at*13.-T*9.,t*16.))*.7+fbm(vec2(at*34.-T*15.,t*42.))*.4;
      float h=(1.-across*across)*1.55*(1.-smoothstep(.2,1.1,s)*.75)-(tear-.25)*(.15+s*1.5);
      h*=smoothstep(-.04,.03,s)*BREATH;
      float smoke=smoothstep(1.7,.5,across)*smoothstep(.2,.8,s)*smoothstep(.55,.25,tear)*.7*BREATH;
      out_c=over(vec4(${vec3(C.fireChar)}*smoke,smoke),out_c);
      float a=smoothstep(.02,.3,h);
      vec3 col=flame(h);
      float tip=smoothstep(.34,.1,h)*smoothstep(.55,.72,tear);
      col=mix(col,${vec3(C.fireEdge)},tip);
      out_c=over(vec4(col*a,a),out_c);
    }
  }
  gl_FragColor=out_c;
}`;

/** The dragon's breath and the burn, over the stage: the night it burns away is a still of the sky. */
export function createFire(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  });
  if (!gl) return null;
  const program = linkProgram(gl, FIRE_SHADER);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    R: at("R"),
    MOUTH: at("MOUTH"),
    AIM: at("AIM"),
    BREATH: at("BREATH"),
    CHAR: at("CHAR"),
    T: at("T"),
  };
  const still = (unit: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  };
  still(0);
  still(1);
  gl.uniform1i(at("NIGHT"), 0);
  gl.uniform1i(at("WORDS"), 1);
  let inked = false;

  return {
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(u.R, width, height);
    },
    /** Call in the same task as the sky's draw: a WebGL canvas clears once the frame is shown. */
    keepNight(sky: HTMLCanvasElement) {
      gl.activeTexture(gl.TEXTURE0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sky);
    },
    keepWords(words: HTMLCanvasElement) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, words);
    },
    /** A pass with nothing to show leaves the canvas cleared, and costs nothing after that. */
    draw(frame: FireFrame | null) {
      if (!frame) {
        if (inked) gl.clear(gl.COLOR_BUFFER_BIT);
        inked = false;
        return;
      }
      const H = canvas.height;
      gl.uniform2f(u.MOUTH, frame.mouth[0] / H, frame.mouth[1] / H);
      gl.uniform2f(u.AIM, frame.aim[0] / H, frame.aim[1] / H);
      gl.uniform1f(u.BREATH, frame.breath);
      gl.uniform1f(u.CHAR, frame.char);
      gl.uniform1f(u.T, frame.time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      inked = true;
    },
  };
}
