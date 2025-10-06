/* ===========================================================
   HeatmapTracker — Vanilla JS heatmap overlay (library-style)
   - Captura mousemove con coordenadas absolutas (pageX/Y)
   - Canvas del tamaño COMPLETO del documento (no solo viewport)
   - Acumula densidad en un canvas offscreen y coloriza con LUT
   - Botón flotante (toggle) inyectado desde JS (sin CSS externo)
   - API: init(opts), start(), stop(), show(), hide(), toggle(), clear()
   =========================================================== */
(function (global){
  const defaultGradient = [
    [0.00, "#0000ff"], // azul
    [0.25, "#00ffff"], // cian
    [0.50, "#00ff00"], // verde
    [0.75, "#ffff00"], // amarillo
    [1.00, "#ff0000"]  // rojo
  ];

  const HeatmapTracker = {
    _enabled: false,
    _visible: false,
    _btn: null,
    _accum: null,     // offscreen canvas (acumulado en escala de grises)
    _accumCtx: null,
    _view: null,      // canvas visible colorizado
    _viewCtx: null,
    _rafScheduled: false,
    _lastRedraw: 0,
    _gradientLUT: null, // Uint8ClampedArray length 256*4
    _opts: {
      radius: 24,          // radio de influencia de cada punto
      pointAlpha: 0.07,    // alpha por trazo (más alto = más “tinta”)
      zIndex: 9999,
      buttonZ: 999999,
      buttonPosition: "bottom-right", // "bottom-right" | "bottom-left" | "top-right" | "top-left"
      buttonTextShow: "Mostrar mapa de calor",
      buttonTextHide: "Ocultar mapa de calor",
      gradient: defaultGradient,
      colorizeIntervalMs: 80, // throttle de colorización
      autoButton: true
    },

    init(opts={}){
      // Mezcla opciones
      Object.assign(this._opts, opts);

      // Inyecta estilos del botón (sin CSS externo)
      this._injectStyles();

      // Prepara LUT de gradiente
      this._gradientLUT = this._buildGradientLUT(this._opts.gradient);

      // Listeners
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onResizeMaybe = this._onResizeMaybe.bind(this);

      // Crear botón si procede
      if (this._opts.autoButton) this._ensureButton();

      // Arranca captura (invisible por defecto)
      this.start();
      return this;
    },

    start(){
      if (this._enabled) return;
      this._enabled = true;
      document.addEventListener('mousemove', this._onMouseMove, {passive:true});
      window.addEventListener('resize', this._onResizeMaybe);
      this._ensureCanvases(); // prepara tamaños aunque esté oculto
    },

    stop(){
      if (!this._enabled) return;
      this._enabled = false;
      document.removeEventListener('mousemove', this._onMouseMove);
      window.removeEventListener('resize', this._onResizeMaybe);
      this.hide();
    },

    show(){
      if (this._visible) return;
      this._visible = true;
      this._ensureCanvases();
      // Dibujo inicial (colorizar todo lo acumulado)
      this._colorizeAll(true);
      this._updateButtonText();
    },

    hide(){
      if (!this._visible) return;
      this._visible = false;
      if (this._view && this._view.parentNode) this._view.parentNode.removeChild(this._view);
      this._view = null;
      this._viewCtx = null;
      this._updateButtonText();
    },

    toggle(){
      if (this._visible) this.hide(); else this.show();
    },

    clear(){
      if (this._accumCtx) {
        this._accumCtx.clearRect(0,0,this._accum.width, this._accum.height);
      }
      if (this._visible && this._viewCtx) {
        this._viewCtx.clearRect(0,0,this._view.width, this._view.height);
      }
    },

    /* ============ Internals ============ */
    _injectStyles(){
      const s = document.createElement('style');
      s.textContent = `
        .hm-toggle-btn {
          position: fixed;
          padding: 10px 14px;
          border: 0;
          border-radius: 10px;
          background: #111;
          color: #fff;
          font: 14px/1 system-ui, Arial, sans-serif;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,.25);
          user-select: none;
        }
        .hm-toggle-btn:active { transform: translateY(1px); }
        .hm-toggle-bottom-right { right: 16px; bottom: 16px; }
        .hm-toggle-bottom-left  { left: 16px; bottom: 16px; }
        .hm-toggle-top-right    { right: 16px; top: 16px; }
        .hm-toggle-top-left     { left: 16px; top: 16px; }
      `;
      document.head.appendChild(s);
    },

    _ensureButton(){
      if (this._btn) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hm-toggle-btn hm-toggle-${this._posClass()}`;
      btn.style.zIndex = String(this._opts.buttonZ);
      btn.textContent = this._opts.buttonTextShow;
      btn.addEventListener('click', () => this.toggle());
      this._btn = btn;
      document.body.appendChild(btn);
    },

    _posClass(){
      switch(this._opts.buttonPosition){
        case 'bottom-left': return 'bottom-left';
        case 'top-right': return 'top-right';
        case 'top-left': return 'top-left';
        default: return 'bottom-right';
      }
    },

    _docSize(){
      const d = document.documentElement, b = document.body;
      const width = Math.max(
        d.scrollWidth, d.offsetWidth, d.clientWidth,
        b ? b.scrollWidth : 0, b ? b.offsetWidth : 0
      );
      const height = Math.max(
        d.scrollHeight, d.offsetHeight, d.clientHeight,
        b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
      );
      return {width, height};
    },

    _ensureCanvases(){
      const {width, height} = this._docSize();

      // Offscreen (acumulación)
      if (!this._accum) {
        this._accum = document.createElement('canvas');
        this._accum.width = width;
        this._accum.height = height;
        this._accumCtx = this._accum.getContext('2d', { willReadFrequently: true });
      } else {
        if (this._accum.width !== width || this._accum.height !== height) {
          // Redimensionar manteniendo contenido
          const tmp = document.createElement('canvas');
          tmp.width = width; tmp.height = height;
          const tctx = tmp.getContext('2d');
          tctx.drawImage(this._accum, 0, 0);
          this._accum.width = width; this._accum.height = height;
          this._accumCtx = this._accum.getContext('2d', { willReadFrequently: true });
          this._accumCtx.drawImage(tmp, 0, 0);
        }
      }

      // Visible (colorizado)
      if (this._visible) {
        if (!this._view) {
          this._view = document.createElement('canvas');
          this._view.width = width;
          this._view.height = height;
          const v = this._view.style;
          v.position = 'absolute';
          v.top = '0'; v.left = '0';
          v.zIndex = String(this._opts.zIndex);
          v.pointerEvents = 'none';
          document.body.appendChild(this._view);
          this._viewCtx = this._view.getContext('2d');
        } else if (this._view.width !== width || this._view.height !== height) {
          const tmp2 = document.createElement('canvas');
          tmp2.width = width; tmp2.height = height;
          const t2 = tmp2.getContext('2d');
          t2.drawImage(this._view, 0, 0);
          this._view.width = width; this._view.height = height;
          this._viewCtx = this._view.getContext('2d');
          this._viewCtx.drawImage(tmp2, 0, 0);
        }
      }
    },

    _onMouseMove(e){
      if (!this._enabled) return;
      const x = e.pageX, y = e.pageY; // incluye scroll
      // Dibujo “gaussiano” aproximado usando un radialGradient
      const r = this._opts.radius;
      const g = this._accumCtx.createRadialGradient(x, y, 0, x, y, r);
      // núcleo más opaco en el centro, desvanecido al borde
      const a = this._opts.pointAlpha;
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(1, `rgba(0,0,0,0)`);
      this._accumCtx.fillStyle = g;
      this._accumCtx.beginPath();
      this._accumCtx.arc(x, y, r, 0, Math.PI*2);
      this._accumCtx.fill();

      // Si es visible, programar colorización (throttled)
      if (this._visible) this._scheduleColorize();
    },

    _onResizeMaybe(){
      // Si cambia tamaño del doc, reacomodar y recolorizar
      if (!this._enabled) return;
      const wasVisible = this._visible;
      this._ensureCanvases();
      if (wasVisible) this._colorizeAll(true);
    },

    _scheduleColorize(){
      const now = performance.now();
      if (this._rafScheduled) return;
      if (now - this._lastRedraw < this._opts.colorizeIntervalMs) {
        this._rafScheduled = true;
        requestAnimationFrame(() => {
          this._rafScheduled = false;
          this._colorizeAll(false);
        });
      } else {
        this._colorizeAll(false);
      }
    },

    _buildGradientLUT(stops){
      // Crea LUT de 256 RGBA a partir de stops [t,color]
      // color puede ser "#rrggbb" o "rgb(...)"
      const lut = new Uint8ClampedArray(256*4);
      // Normaliza y ordena stops
      const s = stops.slice().sort((a,b)=>a[0]-b[0]).map(([t,c])=>[Math.min(1,Math.max(0,t)), _parseColor(c)]);
      for (let i=0;i<256;i++){
        const t = i/255;
        // busca segmento
        let j=0;
        while (j < s.length-1 && t > s[j+1][0]) j++;
        const [t1,c1] = s[Math.max(0,j)];
        const [t2,c2] = s[Math.min(s.length-1, j+1)];
        const local = (t2[0] - t1[0]) > 1e-6 ? (t - t1[0])/(t2[0]-t1[0]) : 0;
        lut[i*4+0] = _lerp(c1[0], c2[0], local);
        lut[i*4+1] = _lerp(c1[1], c2[1], local);
        lut[i*4+2] = _lerp(c1[2], c2[2], local);
        lut[i*4+3] = 255;
      }
      return lut;

      function _parseColor(col){
        if (col.startsWith('#')){
          const n = col.length===4
            ? col.replace(/#/,'').split('').map(h=>h+h).join('')
            : col.replace('#','');
          const r = parseInt(n.slice(0,2),16);
          const g = parseInt(n.slice(2,4),16);
          const b = parseInt(n.slice(4,6),16);
          return [r,g,b];
        } else if (col.startsWith('rgb')){
          const m = col.match(/(\d+\.?\d*)/g).map(Number);
          return [m[0]|0, m[1]|0, m[2]|0];
        }
        // fallback a negro
        return [0,0,0];
      }
      function _lerp(a,b,t){ return (a + (b-a)*t) | 0; }
    },

    _colorizeAll(force){
      if (!this._visible || !this._viewCtx) return;
      this._lastRedraw = performance.now();

      // Copiamos acumulado a ImageData y colorizamos por intensidad
      const w = this._accum.width, h = this._accum.height;
      const src = this._accumCtx.getImageData(0,0,w,h);  // RGBA en escala de grises (hemos pintado negro con alpha)
      const dst = this._viewCtx.createImageData(w,h);
      const S = src.data, D = dst.data, LUT = this._gradientLUT;

      // Determinar intensidad: usamos canal A (acumulado por trazos), si no, la luminancia
      // Nota: por cómo pintamos, el alpha resultante suele ser 255 si se satura; aún así,
      // usamos el canal rojo como fallback (idéntico a g/b al ser gris).
      for (let i=0;i<S.length;i+=4){
        // Escoger mayor entre A y R como "densidad"
        const a = S[i+3];     // alpha
        const r = S[i];       // rojo (gris)
        const v = a || r;     // 0..255
        if (v>0){
          const j = v<<2;     // v*4
          D[i]   = LUT[j  ];
          D[i+1] = LUT[j+1];
          D[i+2] = LUT[j+2];
          // transparencia suave para ver solapamientos: escalar alpha con v
          D[i+3] = Math.min(255, 40 + (v)); // base 40 + densidad
        } else {
          // transparente
          D[i] = D[i+1] = D[i+2] = 0;
          D[i+3] = 0;
        }
      }

      this._viewCtx.putImageData(dst, 0, 0);
    },

    _updateButtonText(){
      if (!this._btn) return;
      this._btn.textContent = this._visible ? this._opts.buttonTextHide : this._opts.buttonTextShow;
    }
  };

  // Exponer global
  global.HeatmapTracker = HeatmapTracker;
})(window);
