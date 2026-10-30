/* M1ndseye 3D glass mechanism: loads a .glb and renders it with raw WebGL (no library).
   Look = the home eye's plasma light, refracted by the glass with chromatic dispersion, prismatic rim and white speculars.
   Gears turn at ratios set by their tooth counts, with the teeth locked into each other.
   Usage: <canvas data-eye3d="assets/mechanical-eye.glb"> then include this script. */
(function () {
  var cv = document.querySelector("canvas[data-eye3d]");
  if (!cv) return;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var HOME = cv.hasAttribute("data-home");   /* home page: transparent canvas drawn on top of the stage plasma, driven by gaze.js */
  var FIT = parseFloat(cv.getAttribute("data-dist")) || 10.6;
  var gl = cv.getContext("webgl", { antialias: true, alpha: HOME, premultipliedAlpha: true, stencil: true });
  if (!gl) { cv.dispatchEvent(new Event("eye3d-fail")); return; }

  /* ---- tiny mat4 ---- */
  function mul(a, b) { var o = new Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function trs(t, q, s) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
             2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
             2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
    for (var i = 0; i < 3; i++) { m[i] *= s[0]; m[4 + i] *= s[1]; m[8 + i] *= s[2]; }
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m;
  }
  function rotZ(a) { var c = Math.cos(a), s = Math.sin(a); return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; }
  function rotY(a) { var c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }
  function rotX(a) { var c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; }
  function persp(f, asp, n, fr) { var t = 1 / Math.tan(f / 2); return [t / asp,0,0,0, 0,t,0,0, 0,0,(fr + n) / (n - fr),-1, 0,0,2 * fr * n / (n - fr),0]; }

  /* ---- GLB parse ---- */
  function parse(buf) {
    var dv = new DataView(buf), jl = dv.getUint32(12, true);
    var j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
    var bin = 20 + jl + 8;
    function acc(i) {
      var a = j.accessors[i], bv = j.bufferViews[a.bufferView];
      var n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type], base = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
      var T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : Uint32Array;
      return new T(buf.slice(base, base + a.count * n * T.BYTES_PER_ELEMENT));
    }
    return { j: j, acc: acc };
  }

  /* ---- shaders ---- */
  function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
  function mk(vs, fs) { var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }

  var PLASMA = [
    "precision highp float;",
    "uniform vec2 uRes; uniform float uPhase; uniform vec2 uPtr; uniform float uPull; uniform float uEnergy; uniform float uTint; uniform float uR; uniform float uScale; uniform float uHomeP;",
    "const float PI = 3.14159265;",
    "float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);",
    "  return mix(mix(h(i), h(i+vec2(1.,0.)), f.x), mix(h(i+vec2(0.,1.)), h(i+vec2(1.,1.)), f.x), f.y); }",
    "float caust(vec2 uv, float t){",
    "  vec2 p = mod(uv*6.28318530718, 6.28318530718) - 250.0;",
    "  vec2 i = p; float c = 1.0; const float inten = .005;",
    "  for (int n = 0; n < 5; n++) {",
    "    float tt = t*(1.0 - (3.5/float(n+1)));",
    "    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));",
    "    c += 1.0/length(vec2(p.x/(sin(i.x+tt)/inten), p.y/(cos(i.y+tt)/inten)));",
    "  }",
    "  c /= 5.0; c = 1.17 - pow(c, 1.4);",
    "  return pow(abs(c), 8.0);",
    "}",
    "float lanes(float x, float wob, float seed, float t, float sc){",
    "  x += wob;",
    "  float id = floor(x), g = abs(fract(x) - .5);",
    "  float on = smoothstep(.30, .62, vn(vec2(id*3.17 + seed, t*.55)));",
    "  return exp(-g*g*sc*sc) * on;",
    "}",
    "// plasma light: tendrils from the eye, one bundle pulled toward the touch point; p is relative to the eye",
    "vec3 plasma(vec2 p){",
    "  float r = length(p), th = atan(p.y, p.x), t = uPhase;",
    "  vec2 q = uPtr; float qr = length(q);",
    "  float thp = atan(q.y, q.x);",
    "  float d = th - thp; d = mod(d + PI, 2.*PI) - PI;",
    "  float wfn = (vn(vec2(r*5. + t*.45, 2.6*cos(th))) + vn(vec2(r*5. + t*.45 + 7., 2.6*sin(th))) - 1.) * 2.6 * smoothstep(0., uR, r); float wfo = (vn(vec2(r*5. + t*.45, th*2.6)) - .5) * 2.6 * smoothstep(0., uR, r); float wf = wfn;",
    "  float free1 = lanes(th*13./(2.*PI), wf, 1., t, 6.28*max(r,.15)/13./.011) + .55*lanes(th*23./(2.*PI), wf*1.4, 7., t*1.3, 6.28*max(r,.15)/23./.011);",
    "  float freeFade = smoothstep(.0, uR*.35, r) * (1. - smoothstep(uR*.7, uR*1.9, r)) / (1. + r*1.2);",
    "  float pinch = uPull * smoothstep(.0, max(qr, .05), r);",
    "  float dE = d / (1. - .94*pinch);",
    "  float wb = (vn(vec2(r*7. - t*.9, dE*2. + t*.3)) - .5) * (1.2 + 3.*uEnergy) * pinch;",
    "  float bund = lanes(dE*9./(2.*PI), wb, 3., t*1.6, 22.);",
    "  float angMask = smoothstep(mix(1.7, .30, uPull), 0., abs(d));",
    "  float endMask = smoothstep(qr + .02, qr - .05, r) * smoothstep(.0, uR*.3, r);",
    "  float touch = bund * angMask * endMask * uPull;",
    "  float fil = free1 * freeFade * (.5 - .3*uPull) + touch * 1.15;",
    "  float dp = length(p - q);",
    "  float hot = exp(-dp*dp*1400.) * uPull;",
    "  float halo = exp(-dp*7.) * .22 * uPull;",
    "  float ripple = exp(-pow((dp - fract(t*.32)*.2)*45., 2.)) * .35 * uPull * (1. - fract(t*.32));",
    "  float amb = caust(p*1.1 + .15, t*.6) * .07 * exp(-r*1.6);",
    "  vec3 sapph = vec3(.18,.42,1.), amber = vec3(1.,.62,.24);",
    "  vec3 tint = mix(sapph, amber, mix(smoothstep(-.28, .28, p.x + (uTint - .5)*.5), clamp(uTint, 0., 1.), uHomeP));",
    "  vec3 col = vec3(.015,.025,.06) + tint*(.05*exp(-r*2.2) + fil*.85 + halo + amb + ripple) + vec3(.8,.9,1.)*(hot*.9 + fil*.06);",
    "  return 1. - exp(-col*1.1);",
    "}",
    "void main(){ vec2 uv = gl_FragCoord.xy / uRes; vec2 p = (uv - .5) * vec2(uRes.x/uRes.y, 1.) * uScale;",
    "  vec3 col = plasma(p); float lum = dot(col, vec3(.33,.34,.33)); if (uHomeP < .5) col = mix(col, vec3(lum)*vec3(.86,.88,1.), .5) * 1.35 + vec3(.15,.16,.24) * exp(-dot(p,p) * 3.2);",
    "  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453) - .5) / 255.;",
    "  gl_FragColor = vec4(col, 1.); }"
  ].join("\n");
  var QUAD_VS = "attribute vec2 q; void main(){ gl_Position = vec4(q, 0., 1.); }";
  var BLIT_FS = "precision highp float; uniform sampler2D bg; uniform vec2 uRes; void main(){ gl_FragColor = vec4(texture2D(bg, gl_FragCoord.xy / uRes).rgb, 1.); }";

  var MESH_VS = "attribute vec3 p;attribute vec3 n;uniform mat4 M,V,P;varying vec3 vn;" +
    "void main(){vec4 w=M*vec4(p,1.);vn=mat3(V)*(mat3(M)*n);gl_Position=P*V*w;}";
  var MESH_FS = [
    "precision highp float; varying vec3 vn; uniform sampler2D bg; uniform vec2 uRes; uniform vec2 uGaze; uniform float uPhase; uniform float uGain; uniform float uThick; uniform float uHome; uniform vec3 uMetal; uniform float uIsMetal;",
    "// broad strips of light behind the glass: they exist to be bent and split by it",
    "vec3 strips(vec2 p, vec2 m){",
    "  vec3 c = vec3(0.);",
    "  float a1 = 1.15, a2 = -1.0, a3 = .3, a4 = 1.9, a5 = -.35;",
    "  c += vec3(.55,.75,1.)  * smoothstep(.075, 0., abs(dot(p - vec2(-.30,0.) - m*.9,  vec2(-sin(a1), cos(a1)))));",
    "  c += vec3(1.,.62,.26)  * smoothstep(.060, 0., abs(dot(p - vec2(.26,0.)  + m*1.4, vec2(-sin(a2), cos(a2)))));",
    "  c += vec3(1.)          * smoothstep(.030, 0., abs(dot(p - vec2(-.04,0.) - m*.6,  vec2(-sin(a3), cos(a3))))) * 1.2;",
    "  c += vec3(.35,.55,1.)  * smoothstep(.050, 0., abs(dot(p - vec2(.05,.10) + m*1.1, vec2(-sin(a4), cos(a4)))));",
    "  c += vec3(1.,.8,.5)    * smoothstep(.035, 0., abs(dot(p - vec2(-.15,-.1) - m*1.7, vec2(-sin(a5), cos(a5))))) * .9;",
    "  return c;",
    "}",
    "void main(){",
    "  vec3 N = normalize(vn); if (!gl_FrontFacing) N = -N;",
    "  vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y; vec2 p = (uv - .5) * vec2(asp, 1.);",
    "  if (uIsMetal > .5) {",
    "    vec2 gm = vec2(uGaze.x, -uGaze.y); vec3 R = reflect(vec3(0., 0., -1.), N);",
    "    vec3 env = texture2D(bg, clamp(uv + R.xy*.28, 0., 1.)).rgb * 1.1 + strips((uv + R.xy*.28 - .5) * vec2(asp, 1.), gm*.07) * .9;",
    "    vec3 Lm = normalize(vec3(uGaze.x*1.1 - .3, -uGaze.y*1.1 + .5, .8));",
    "    float dm = max(dot(N, Lm), 0.), sm = pow(max(dot(N, normalize(Lm + vec3(0.,0.,1.))), 0.), 38.);",
    "    vec3 mc = uMetal * (.10 + .55*dm) + uMetal * env * .55 + vec3(1.) * sm * .8 + vec3(.5,.6,.85) * pow(1. - abs(N.z), 3.) * .35;",
    "    mc = mc / (1. + mc*.4);",
    "    gl_FragColor = vec4(mc, 1.); return;",
    "  }",
    "  float edge = smoothstep(.0, .8, 1. - abs(N.z));",
    "  float bend = (.035 + .14*edge) * uThick;",
    "  vec2 g = vec2(uGaze.x, -uGaze.y);",
    "  vec3 acc = vec3(0.); vec3 wsum = vec3(.0001);",
    "  for (int k = 0; k < 8; k++) {",
    "    float t = float(k) / 7.;",
    "    vec2 off = -N.xy * bend * (.55 + 1.75*t);",
    "    vec2 uvk = clamp(uv + off, 0., 1.); vec2 pk = (uvk - .5) * vec2(asp, 1.);",
    "    vec3 w = .5 + .5*cos(6.28318*(t*.78 - vec3(0., .33, .67) + .02));",
    "    w = w*w;",
    "    vec3 smp = texture2D(bg, uvk).rgb*.8 + strips(pk, g*.07)*1.5;",
    "    acc += smp * w; wsum += w;",
    "  }",
    "  vec3 r = acc / wsum;",
    "  vec2 s = p / .9;",
    "  float hu = dot(s, normalize(g + vec2(1e-3))) * 2.6 + uPhase*.05;",
    "  vec3 rb = .5 + .5*cos(6.28318*(hu + vec3(0., .33, .67)));",
    "  float lenG = min(1., length(g));",
    "  float e2 = edge*edge;",
    "  vec2 pf = p + g*.10*uThick + N.xy*.05;",
    "  vec3 face = (strips(pf, g*.05) * .55 + texture2D(bg, clamp(uv + g*.02*uThick, 0., 1.)).rgb * .55) * (1. - e2);",
    "  vec3 col = r * (.03 + 1.35*e2) + face * .34;",
    "  col += rb * e2 * (.14 + .42*lenG);",
    "  vec3 L1 = normalize(vec3(uGaze.x*1.1 - .35, -uGaze.y*1.1 + .45, .7));",
    "  vec3 L2 = normalize(vec3(-uGaze.x*.9 + .5, uGaze.y*.7 - .3, .8));",
    "  float sp1 = pow(max(dot(N, normalize(L1 + vec3(0.,0.,1.))), 0.), 160.);",
    "  float sp2 = pow(max(dot(N, normalize(L2 + vec3(0.,0.,1.))), 0.), 90.);",
    "  col += vec3(1.) * sp1 * (.35 + 1.1*edge) + vec3(.65,.8,1.) * sp2 * (.2 + .8*edge);",
    "  float glint = smoothstep(.72, .98, edge) * (.5 + .5*sin(dot(p, vec2(9.,5.)) + g.x*6. - g.y*4.));",
    "  col += vec3(1.,.95,.9) * glint * .35;",
    "  col *= uGain; col = col / (1. + col*.4); col = pow(col, vec3(.95));",
    "  gl_FragColor = vec4(col, uHome > .5 ? clamp(max(col.r, max(col.g, col.b)), 0., 1.) : 1.);",
    "}"
  ].join("\n");

  var plasmaProg = mk(QUAD_VS, PLASMA), blitProg = mk(QUAD_VS, BLIT_FS), meshProg = mk(MESH_VS, MESH_FS);
  function U(pr, names) { var o = {}; names.forEach(function (k) { o[k] = gl.getUniformLocation(pr, k); }); return o; }
  var uPl = U(plasmaProg, ["uRes","uPhase","uPtr","uPull","uEnergy","uTint","uR","uScale","uHomeP"]);
  var uBl = U(blitProg, ["bg","uRes"]);
  var uMe = U(meshProg, ["M","V","P","bg","uRes","uGaze","uPhase","uGain","uThick","uHome","uMetal","uIsMetal"]);
  var aPl = gl.getAttribLocation(plasmaProg, "q"), aBl = gl.getAttribLocation(blitProg, "q");
  var aP = gl.getAttribLocation(meshProg, "p"), aN = gl.getAttribLocation(meshProg, "n");
  var quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  /* ---- plasma light rendered once per frame into a half-resolution texture ---- */
  var tex = gl.createTexture(), fbo = gl.createFramebuffer(), FW = 2, FH = 2;
  function allocFBO(w, h) {
    FW = Math.max(2, w); FH = Math.max(2, h);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FW, FH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---- gear train ----
     Measured from the model: tooth count N, pitch radius (mid-tooth), and the angle of a tooth tip at rest.
     Meshing pairs: big wheel - tiny gear - toothed ring, and the two right-hand gears.
     Speeds follow 1/N with alternating direction; each pair's start angles put a tooth into the neighbour's gap. */
  var GEAR = {
    "Cube.004": { N: 88, tip: 0.00002 },     /* big wheel */
    "gear.tiny": { N: 10, tip: -0.31416 },
    "gear.iris": { N: 45, tip: 0.03467 },    /* toothed ring */
    "gear.10":  { N: 10, tip: -0.31416 },
    "Cube.003": { N: 19, tip: -0.08277 }
  };
  var parts = [], byName = {}, train = null;
  function ang(a, b) { return Math.atan2(b.t[1] - a.t[1], b.t[0] - a.t[0]); }
  function setupTrain() {
    var g4 = byName["Cube.004"], g2 = byName["gear.tiny"], g7 = byName["gear.iris"], gC = byName["gear.10"], g3 = byName["Cube.003"];
    if (!(g4 && g2 && g7 && gC && g3)) return;
    var G = function (n) { return GEAR[n]; }, base = function (n) { return GEAR[n].tip + byName[n].rotZ; };
    var b42 = ang(g4, g2), b27 = ang(g2, g7), bC3 = ang(gC, g3), PI = Math.PI;
    var w4 = .10, wC = .45;
    train = function (t) {
      var th4 = w4 * t, th4r = b42 - base("Cube.004");
      var th2 = -(G("Cube.004").N / G("gear.tiny").N) * (th4 - th4r) + (b42 + PI - base("gear.tiny") - PI / G("gear.tiny").N);
      var th2p = b27 - base("gear.tiny");
      var th7 = -(G("gear.tiny").N / G("gear.iris").N) * (th2 - th2p) + (b27 + PI - base("gear.iris") - PI / G("gear.iris").N);
      var thC = wC * t, thCr = bC3 - base("gear.10");
      var th3 = -(G("gear.10").N / G("Cube.003").N) * (thC - thCr) + (bC3 + PI - base("Cube.003") - PI / G("Cube.003").N);
      return { "Cube.004": th4, "gear.tiny": th2, "gear.iris": th7, "gear.10": thC, "Cube.003": th3 };
    };
  }
  function build(buf) {
    var g = parse(buf), j = g.j;
    j.nodes.forEach(function (nd) {
      if (nd.mesh === undefined) return;
      var pr = j.meshes[nd.mesh].primitives[0];
      var P = g.acc(pr.attributes.POSITION), N = g.acc(pr.attributes.NORMAL), I = g.acc(pr.indices);
      var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, P, gl.STATIC_DRAW);
      var nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, N, gl.STATIC_DRAW);
      var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
      var part = { name: nd.name, vb: vb, nb: nb, ib: ib, count: I.length, type: I instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT,
        t: (nd.translation || [0,0,0]).slice(), q: nd.rotation || [0,0,0,1], s: nd.scale || [1,1,1], pane: nd.name === "eye.frame", irisSpeed: nd.name === "iris" ? -.08 : 0,
        rotZ: nd.rotation ? 2 * Math.atan2(nd.rotation[2], nd.rotation[3]) : 0, metal: null };
      var mt = pr.material !== undefined ? j.materials[pr.material] : null;
      if (mt && mt.pbrMetallicRoughness && mt.pbrMetallicRoughness.baseColorFactor) part.metal = mt.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
      parts.push(part); byName[nd.name] = part;
    });
    /* eye-shaped mask: outer silhouette of the glass frame, so the frame's opening is filled too */
    var pl = byName["eye.frame"];
    if (pl) {
      var pr0 = j.meshes[j.nodes.filter(function (n) { return n.name === "eye.frame"; })[0].mesh].primitives[0], PP = g.acc(pr0.attributes.POSITION);
      var NB = 720, rad = new Float32Array(NB), k;
      for (k = 0; k < PP.length; k += 3) { var ax = Math.atan2(PP[k + 1], PP[k]), b = Math.floor((ax + Math.PI) / (2 * Math.PI) * NB) % NB, rr = Math.hypot(PP[k], PP[k + 1]); if (rr > rad[b]) rad[b] = rr; }
      for (var pass = 0; pass < 4; pass++) for (k = 0; k < NB; k++) if (rad[k] === 0) { var lo = rad[(k + NB - 1) % NB], hi = rad[(k + 1) % NB]; if (lo && hi) rad[k] = (lo + hi) / 2; else if (lo || hi) rad[k] = lo || hi; }
      var fan = [0, 0, 0], fn = [0, 0, 1];
      for (k = 0; k <= NB; k++) { var a2 = (k % NB + .5) / NB * 2 * Math.PI - Math.PI; fan.push(Math.cos(a2) * rad[k % NB] * 1.003, Math.sin(a2) * rad[k % NB] * 1.003, 0); fn.push(0, 0, 1); }
      var fvb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, fvb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.STATIC_DRAW);
      var fnb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, fnb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fn), gl.STATIC_DRAW);
      pl.fan = { vb: fvb, nb: fnb, n: NB + 2 };
    }
    setupTrain();
    parts.sort(function (a, b) { return (a.pane ? 1 : 0) - (b.pane ? 1 : 0); });
  }

  /* ---- sizing, pointer ---- */
  var W = 0, H = 0, dpr = 1;
  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var r = cv.getBoundingClientRect(); W = Math.max(2, Math.round(r.width * dpr)); H = Math.max(2, Math.round(r.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    allocFBO(Math.round(W / 2), Math.round(H / 2));
  }
  size(); window.addEventListener("resize", size);
  var G = null;
  var tx = 0, ty = 0, gx = 0, gy = 0;
  function ptr(e) { var r = cv.getBoundingClientRect(); tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - .5) * 2)); ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - .5) * 2)); }
  window.addEventListener("pointermove", ptr, { passive: true });
  window.addEventListener("pointerdown", ptr, { passive: true });

  var CENTER = [0, 0, .9], lookA = 2.28, PUPIL_REST = 2.28;   /* PUPIL_REST: where the pupil's circle sits around the centre in the model (about 131 degrees) */
  var t0 = performance.now(), running = true;
  function drawQuad(prog, attr) { gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(attr); gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
  function draw(now, still) {
    var t = (now - t0) / 1000, ph = still ? 3 : t;
    G = HOME ? window.__gaze : null;
    if (HOME && !G) return;
    if (HOME) { if (Math.abs(cv.clientWidth * dpr - cv.width) > 2) size(); gx = G.gx; gy = G.gy; ph = G.phase; }
    else { gx += (tx - gx) * .06; gy += (ty - gy) * .06; }
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
    /* 1. plasma light into the texture */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, FW, FH);
    gl.useProgram(plasmaProg);
    var asp = W / H;
    gl.uniform2f(uPl.uRes, FW, FH); gl.uniform1f(uPl.uPhase, ph); gl.uniform1f(uPl.uHomeP, HOME ? 1 : 0);
    if (HOME) { gl.uniform2f(uPl.uPtr, G.ptr[0], G.ptr[1]); gl.uniform1f(uPl.uPull, G.pull); gl.uniform1f(uPl.uEnergy, G.energy); gl.uniform1f(uPl.uTint, G.tint); gl.uniform1f(uPl.uR, G.R); gl.uniform1f(uPl.uScale, G.scale); }
    else { gl.uniform2f(uPl.uPtr, gx * .35 * asp, -gy * .35); gl.uniform1f(uPl.uPull, 0); gl.uniform1f(uPl.uEnergy, 0); gl.uniform1f(uPl.uTint, .42 + .4 * gx); gl.uniform1f(uPl.uR, .42); gl.uniform1f(uPl.uScale, 1); }
    drawQuad(plasmaProg, aPl);
    /* 2. show it as the backdrop */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, HOME ? 0 : 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (!HOME) { gl.useProgram(blitProg); gl.uniform1i(uBl.bg, 0); gl.uniform2f(uBl.uRes, W, H); drawQuad(blitProg, aBl); }
    /* 3. the glass, additive so overlapping layers glow through each other */
    gl.useProgram(meshProg);
    var dist = (asp > 1.7 ? FIT : FIT * (1.7 / asp) * .84);
    var tiltY = gx * .22, tiltX = gy * .14;
    var V = mul(mul([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-dist,1], mul(rotX(tiltX), rotY(tiltY))), [1,0,0,0, 0,1,0,0, 0,0,1,0, -CENTER[0], -CENTER[1], -CENTER[2], 1]);
    gl.uniformMatrix4fv(uMe.V, false, new Float32Array(V));
    gl.uniformMatrix4fv(uMe.P, false, new Float32Array(persp(.55, asp, .5, 60)));
    gl.uniform1i(uMe.bg, 0); gl.uniform1f(uMe.uHome, HOME ? 1 : 0); gl.uniform2f(uMe.uRes, W, H); gl.uniform2f(uMe.uGaze, gx, gy); gl.uniform1f(uMe.uPhase, ph);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.CULL_FACE);
    var spin = train ? train(still ? 0 : t) : {};
    if (Math.hypot(gx, gy) > .06) {
      var want = Math.atan2(-gy, gx), dA = want - lookA;
      dA = Math.atan2(Math.sin(dA), Math.cos(dA));   /* shortest way round */
      lookA += dA * .14;
    }
    function drawPart(p) {
      var local = trs(p.t, p.q, p.s);
      if (p.name === "pupil") {
        /* the pupil turns about the eye's centre axis (its origin) and stays parallel to the iris gear:
           the offset circle orbits around the centre toward the pointer */
        local = mul(trs(p.t, [0, 0, 0, 1], [1, 1, 1]), mul(rotZ(lookA - PUPIL_REST), trs([0, 0, 0], p.q, p.s)));
      }
      if (p.name === "iris") {
        local = mul([1,0,0,0, 0,1,0,0, 0,0,1,0, gx * .06, -gy * .045, 0, 1], local);
      }
      if (spin[p.name] !== undefined) local = mul(local, rotZ(spin[p.name]));
      else if (p.irisSpeed) local = mul(local, rotY((still ? 0 : t) * p.irisSpeed * 6.2832));
      gl.uniformMatrix4fv(uMe.M, false, new Float32Array(local));
      gl.uniform1f(uMe.uGain, p.pane ? .9 : 1); gl.uniform1f(uMe.uThick, p.pane ? 3.0 : 1.15);
      gl.uniform1f(uMe.uIsMetal, p.metal ? 1 : 0); if (p.metal) gl.uniform3f(uMe.uMetal, p.metal[0], p.metal[1], p.metal[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.vb); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.nb); gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ib); gl.drawElements(gl.TRIANGLES, p.count, p.type, 0);
    }
    /* metal first: opaque, writes depth, so glass behind it is hidden and glass in front still adds light */
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    parts.forEach(function (p) { if (p.metal) drawPart(p); });
    gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
    var pane = byName["eye.frame"];
    if (pane) {
      gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 1, 255); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false); gl.depthMask(false);
      if (pane.fan) {
        gl.uniformMatrix4fv(uMe.M, false, new Float32Array(trs(pane.t, pane.q, pane.s)));
        gl.bindBuffer(gl.ARRAY_BUFFER, pane.fan.vb); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, pane.fan.nb); gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, pane.fan.n);
      }
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 255); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    }
    gl.depthMask(false);
    parts.forEach(function (p) { if (!p.pane && !p.metal) drawPart(p); });
    gl.disable(gl.STENCIL_TEST);
    if (pane) { gl.uniform1f(uMe.uIsMetal, 0); drawPart(pane); }
    gl.depthMask(true);
    document.documentElement.setAttribute("data-eye3d", "ready");
  }
  if (HOME) window.__eye3dDraw = function (now) { draw(now, reduce); };
  /* standalone canvases (not the home eye): load only near the viewport, and draw only while visible */
  var onScreen = !cv.hasAttribute("data-lazy"), looping = false, loaded = false;
  function kick() { if (!HOME && running && onScreen && loaded && !looping) { looping = true; requestAnimationFrame(loop); } }
  function loop(now) { if (HOME || !running || !onScreen) { looping = false; return; } draw(now, reduce); if (!reduce) requestAnimationFrame(loop); else looping = false; }
  document.addEventListener("visibilitychange", function () { running = !document.hidden; kick(); });
  function load() {
    fetch(cv.getAttribute("data-eye3d")).then(function (r) { return r.arrayBuffer(); }).then(function (b) { build(b); loaded = true; if (HOME) { window.__eye3dActive = true; } else kick(); })
      .catch(function (e) { console.log("eye3d failed", e); cv.dispatchEvent(new Event("eye3d-fail")); });
  }
  if (!HOME && cv.hasAttribute("data-lazy") && "IntersectionObserver" in window) {
    var started = false;
    new IntersectionObserver(function (en) {
      onScreen = en[0].isIntersecting;
      if (onScreen && !started) { started = true; load(); } else kick();
    }, { rootMargin: "300px 0px" }).observe(cv);
  } else { onScreen = true; load(); }
  window.__eye3d = { look: function () { return [lookA, gx, gy]; }, draw: function (tm) { draw(t0 + tm * 1000, false); }, gears: function () { return train; } };
})();
