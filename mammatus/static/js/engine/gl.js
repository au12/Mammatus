// Small WebGL2 helpers.

export function compile(gl, vsSrc, fsSrc, defines = [], feedback = null) {
  const pre = defines.map((d) => `#define ${d}\n`).join("");
  const inject = (src) => src.replace(/^(#version 300 es\n)/, `$1${pre}`);
  const vs = shader(gl, gl.VERTEX_SHADER, inject(vsSrc));
  const fs = shader(gl, gl.FRAGMENT_SHADER, inject(fsSrc));
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (feedback) gl.transformFeedbackVaryings(prog, feedback, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(prog, info.name);
  }
  const attribs = {};
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(prog, i);
    attribs[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { prog, uniforms, attribs };
}

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split("\n").map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join("\n");
    gl.deleteShader(s);
    throw new Error(`shader compile failed: ${log}\n${lines}`);
  }
  return s;
}

export function texture(gl, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const filter = opts.filter || gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmap ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function imageTexture(gl, img, { mipmap = true, wrap = true, aniso = null } = {}) {
  const t = texture(gl, { mipmap, wrapS: wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE });
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  return t;
}

export function dataTexture(gl, w, h, comps, data) {
  const t = texture(gl, { filter: gl.NEAREST });
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  if (comps === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16UI, w, h, 0, gl.RG_INTEGER, gl.UNSIGNED_SHORT, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  return t;
}

export function buffer(gl, data, usage) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
  return b;
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}
