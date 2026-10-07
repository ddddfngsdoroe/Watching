(function() {
    'use strict';

    const oldRoot = document.getElementById('pp-root');
    if (oldRoot) oldRoot.remove();
    const oldStyle = document.getElementById('pp-root-style');
    if (oldStyle) oldStyle.remove();
    const oldIcon = document.getElementById('pp-mini-icon');
    if (oldIcon) oldIcon.remove();
    if (window.__watchingLoaded) return;
    window.__watchingLoaded = true;

    // ============ SETTINGS ============
    const settings = {
        esp: {
            enabled: false,
            showTeam: false, showEnemy: false, showName: false,
            showHealth: false, showDistance: false, filled: false,
            corners: false, offscreen: false, glow: false,
            skeleton: false, snapline: false
        },
        aim: {
            enabled: false,
            alwaysOn: false,
            key: 'Mouse2',
            fov: 15, smooth: 5,
            targetBone: 'head', visibleOnly: false, teamCheck: false,
            drawFov: false, maxDist: 200,
            // PROJECTILE MODE
            projectileSnap: true,       // grenade/molotov atarken tam hedefe kilitlen
            projectileBone: 'chest',    // mermi için hedef bone
            projectileSmooth: 1         // mermi için smooth (1 = anında)
        },
        visual: {
            noRecoil: false, noSpread: false, noSpreadAggressive: false,
            fovChanger: false, fovValue: 140,
            vmFovEnabled: false,
            vmFovValue: 68,
            vmFovPreset: 'default',
            thirdPerson: false,
            thirdPersonDist: 3.0,
            thirdPersonHideVM: true,
            thirdPersonShowModel: true,
            aspectEnabled: false, aspectRatio: '16:9',
            weaponOpacity: 1.0, handsOpacity: 1.0,
            weaponColor: '#8b5cf6', handsColor: '#22d3ee'
        },
        player: {
            infAmmo: false, noReload: false,
            crosshair: {
                enabled: false, style: 'cross', color: '#00ff00',
                size: 8, thickness: 2, gap: 4, dot: false,
                dotSize: 2, outline: false, outlineWidth: 1, alpha: 1.0
            },
            movement: {
                bhopEnabled: false, bhopKey: 'Space',
                bhopSpeed: 1.12, bhopMaxSpeed: 12.0,
                strafeEnabled: false, strafeStrength: 0.4,
                speedEnabled: false, speedMultiplier: 1.5, speedKey: '',
                gravityEnabled: false, gravityMultiplier: 0.7
            }
        },
        playerEffects: {
            lightning: {
                enabled: false, duration: 450,
                color1: '#00bfff', color2: '#ffffff',
                thickness: 3.5, branches: 2
            }
        },
        skin: { cachedData: null }
    };

    const SKEL = {
        colorEnemy: '#ff3030', colorTeam: '#30ff30',
        thickness: 2, drawHead: true, headRadius: 6,
        drawJoints: true, jointSize: 3,
        outline: true, outlineColor: '#000000'
    };

    // ============ THIRD PERSON MODEL STATE ============
    const tpModels = new Map();
    let tpActiveGame = null;
    let tpActiveTeam = null;
    let tpAgent = null;
    let tpLoading = false;
    let tpRetryAt = 0;
    let tpLastTime = 0;
    let tpWeaponKey = '';
    let tpShakeHookInstalled = false;
    let tpLastHiddenVM = null;
    let tpSavedVMVisible = true;

    function hideViewModel(scene) {
        if (!scene) return;
        if (tpLastHiddenVM !== scene) {
            restoreViewModelVisibility();
            tpLastHiddenVM = scene;
            tpSavedVMVisible = scene.visible;
        }
        scene.visible = false;
    }

    function restoreViewModelVisibility() {
        if (tpLastHiddenVM) {
            tpLastHiddenVM.visible = tpSavedVMVisible;
            tpLastHiddenVM = null;
        }
    }

    function applyThirdPersonCamera(game, camera) {
        if (!game || !camera || !game.player) return;
        if (!settings.visual.thirdPerson) return;
        if (game.state !== 'playing') return;
        if (!game.player.alive) return;
        if (camera !== game.camera) return;

        try {
            const backward = camera.position.clone()
                .set(0, 0, 1)
                .applyQuaternion(camera.quaternion);

            let distance = settings.visual.thirdPersonDist || 3;

            const eye = camera.position.clone();
            const hit = game.physics?.raycast?.(
                eye.x, eye.y, eye.z,
                backward.x, backward.y, backward.z,
                distance,
                2
            );

            if (hit && Number.isFinite(hit.t)) {
                distance = Math.max(0, Math.min(distance, hit.t - 0.18));
            }

            camera.position.addScaledVector(backward, distance);
            camera.updateMatrixWorld(true);

            if (settings.visual.thirdPersonHideVM) {
                if (distance > 0.45) {
                    hideViewModel(game.viewmodel?.scene);
                } else {
                    restoreViewModelVisibility();
                }
            } else {
                restoreViewModelVisibility();
            }
        } catch (e) {}
    }

    async function ensureThirdPersonModel(game) {
        const team = game?.player?.team;
        if (!['CT', 'T'].includes(team)) return;
        if (tpLoading) return;
        if (performance.now() < tpRetryAt) return;

        if (tpActiveGame === game && tpActiveTeam === team && tpAgent) return;

        if (tpAgent && tpAgent.root) {
            try { tpAgent.root.parent?.remove(tpAgent.root); } catch {}
        }
        tpAgent = null;
        tpActiveGame = game;
        tpActiveTeam = team;
        tpWeaponKey = '';

        const cached = tpModels.get(team);
        if (cached) {
            tpAgent = cached;
            if (game.scene) {
                game.scene.add(tpAgent.root);
                tpAgent.root.visible = false;
            }
            return;
        }

        const sample = game.botMgr?.bots?.find(b => b.cs2Agent?.model)?.cs2Agent;
        if (!sample) {
            tpRetryAt = performance.now() + 1000;
            return;
        }

        tpLoading = true;
        try {
            const model = new sample.constructor(game.renderer);
            await model.load(team);

            model.root.visible = false;
            tpModels.set(team, model);
            tpAgent = model;

            if (game.scene) {
                game.scene.add(tpAgent.root);
            }
        } catch (e) {
            tpRetryAt = performance.now() + 5000;
        } finally {
            tpLoading = false;
        }
    }

    function updateThirdPersonModel(game) {
        if (!settings.visual.thirdPerson) return;
        if (!settings.visual.thirdPersonShowModel) return;
        if (!game || game.state !== 'playing') return;
        if (!game.player?.alive) return;
        if (!tpAgent) return;
        if (tpActiveGame !== game) return;

        const p = game.player;

        const now = performance.now();
        const dt = tpLastTime ? Math.min(0.05, (now - tpLastTime) / 1000) : 1/60;
        tpLastTime = now;

        try {
            if (typeof tpAgent.setTransform === 'function') {
                tpAgent.setTransform(p.x, p.y - (p._stepLift || 0), p.z, p.yaw);
            } else {
                tpAgent.root.position.set(p.x, p.y, p.z);
                tpAgent.root.rotation.y = p.yaw + Math.PI;
            }

            try {
                tpAgent.update(dt, {
                    vx: p.vx || 0,
                    vz: p.vz || 0,
                    airborne: !p.onGround,
                    crouch: p.crouching ? 1 : 0,
                    pitch: p.pitch,
                    flashed: 0
                });
            } catch (e) {}

            tpAgent.root.updateMatrixWorld(true);

            const weaponId = game.weapons?.current;
            if (weaponId && tpWeaponKey !== weaponId) {
                tpWeaponKey = weaponId;
                try {
                    Promise.resolve(
                        tpAgent.setWeapon(weaponId, game.weapons.def()?.class)
                    ).catch(() => {});
                } catch (e) {}
            }

            tpAgent.root.visible = true;
        } catch (e) {}
    }

    function cleanupThirdPersonModel() {
        if (tpAgent && tpAgent.root) {
            try { tpAgent.root.parent?.remove(tpAgent.root); } catch {}
        }
        tpAgent = null;
        tpActiveGame = null;
        tpActiveTeam = null;
        tpWeaponKey = '';
        tpLastTime = 0;
    }

    function installThirdPersonHooks(game) {
        if (!game) return;

        const effects = game.effects;
        if (!effects?.applyShake) return;
        if (tpShakeHookInstalled && effects.__tpWatchingHook) return;

        const original = effects.applyShake;

        effects.applyShake = function(camera, ...args) {
            const result = original.call(this, camera, ...args);

            if (camera === game.camera) {
                try {
                    applyThirdPersonCamera(game, camera);
                } catch (e) {}
            }

            return result;
        };

        effects.__tpWatchingHook = true;
        tpShakeHookInstalled = true;
    }

    // ============ VIEWMODEL FOV ============
    let vmFovOriginal = null;
    let vmFovHooked = false;
    let vmFovOriginalUpdate = null;

    const VM_FOV_PRESETS = {
        'default': 68, 'close': 50, 'classic': 54,
        'wide': 90, 'ultra': 110, 'low': 40
    };

    function applyViewModelFov() {
        try {
            const game = window.game;
            if (!game || !game.viewmodel) return;
            const vmCam = game.viewmodel.camera;
            if (!vmCam) return;

            if (vmFovOriginal === null && typeof vmCam.fov === 'number') {
                vmFovOriginal = vmCam.fov;
            }

            if (!vmFovHooked && vmCam.updateProjectionMatrix) {
                const origFn = vmCam.updateProjectionMatrix.bind(vmCam);
                vmFovOriginalUpdate = origFn;
                vmCam.updateProjectionMatrix = function() {
                    if (settings.visual.vmFovEnabled) {
                        const targetFov = settings.visual.vmFovValue;
                        if (Math.abs(vmCam.fov - targetFov) > 0.01) vmCam.fov = targetFov;
                    }
                    return origFn();
                };
                vmFovHooked = true;
            }

            if (settings.visual.vmFovEnabled) {
                const targetFov = settings.visual.vmFovValue;
                if (Math.abs(vmCam.fov - targetFov) > 0.01) {
                    vmCam.fov = targetFov;
                    if (typeof vmFovOriginalUpdate === 'function') {
                        const saved = vmCam.updateProjectionMatrix;
                        vmCam.updateProjectionMatrix = vmFovOriginalUpdate;
                        vmCam.updateProjectionMatrix();
                        vmCam.updateProjectionMatrix = saved;
                    }
                }
            } else if (vmFovOriginal !== null) {
                if (Math.abs(vmCam.fov - vmFovOriginal) > 0.01) {
                    vmCam.fov = vmFovOriginal;
                    if (typeof vmFovOriginalUpdate === 'function') {
                        const saved = vmCam.updateProjectionMatrix;
                        vmCam.updateProjectionMatrix = vmFovOriginalUpdate;
                        vmCam.updateProjectionMatrix();
                        vmCam.updateProjectionMatrix = saved;
                    }
                }
            }
        } catch {}
    }

    function restoreViewModelFov() {
        try {
            const game = window.game;
            if (!game || !game.viewmodel || !game.viewmodel.camera) return;
            const vmCam = game.viewmodel.camera;
            if (vmFovOriginal !== null) {
                vmCam.fov = vmFovOriginal;
                if (typeof vmFovOriginalUpdate === 'function') {
                    const saved = vmCam.updateProjectionMatrix;
                    vmCam.updateProjectionMatrix = vmFovOriginalUpdate;
                    vmCam.updateProjectionMatrix();
                    vmCam.updateProjectionMatrix = saved;
                }
            }
        } catch {}
    }

    // ============ TRANSPARENCY ============
    const origMats = new WeakMap();
    const overriddenMeshes = new Set();
    let transparencyActive = false;

    function hexToInt(hex) {
        try { return parseInt(hex.replace('#', ''), 16); } catch { return 0xffffff; }
    }

    function applyTransparency() {
        const game = window.game;
        if (!game || !game.viewmodel) return;
        const vm = game.viewmodel;
        const scene = vm.scene;
        if (!scene) return;
        let hm = null;
        scene.traverse(o => {
            if (hm) return;
            if ((o.name || '').toLowerCase() === 'hand-mirror') hm = o;
        });
        if (!hm) return;
        const wpnOp = settings.visual.weaponOpacity;
        const handOp = settings.visual.handsOpacity;
        const wpnCol = hexToInt(settings.visual.weaponColor);
        const handCol = hexToInt(settings.visual.handsColor);
        if (wpnOp >= 1.0 && handOp >= 1.0) {
            if (transparencyActive) restoreTransparency();
            return;
        }
        transparencyActive = true;
        for (let i = 1; i < hm.children.length; i++) {
            const group = hm.children[i];
            if (!group || !group.visible) continue;
            group.traverse(mesh => {
                if (!mesh.isMesh && !mesh.isSkinnedMesh) return;
                if (!mesh.visible || !mesh.material) return;
                let isHand = false;
                let p = mesh, d = 0;
                while (p && d < 8) {
                    const n = (p.name || '').toLowerCase();
                    if (n === 'lhand' || n === 'rhand' || n.includes('hand')) { isHand = true; break; }
                    p = p.parent; d++;
                }
                const targetOp = isHand ? handOp : wpnOp;
                const targetCol = isHand ? handCol : wpnCol;
                if (targetOp >= 1.0) {
                    if (mesh.userData._ppv && origMats.has(mesh)) {
                        mesh.material = origMats.get(mesh);
                        origMats.delete(mesh);
                        mesh.userData._ppv = false;
                        overriddenMeshes.delete(mesh);
                    }
                    return;
                }
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                let alreadyOurs = true;
                for (const m of mats) if (!m || !m._ppCustom) { alreadyOurs = false; break; }
                if (!alreadyOurs) {
                    if (!origMats.has(mesh)) origMats.set(mesh, mesh.material);
                    const newMats = mats.map(orig => {
                        if (!orig) return orig;
                        const nm = orig.clone();
                        nm.transparent = true; nm.opacity = targetOp;
                        nm.depthTest = false; nm.depthWrite = true;
                        if (nm.color) nm.color.setHex(targetCol);
                        if (nm.emissive) { nm.emissive.setHex(targetCol); nm.emissiveIntensity = 0.8; }
                        nm.needsUpdate = true; nm._ppCustom = true;
                        return nm;
                    });
                    mesh.material = Array.isArray(mesh.material) ? newMats : newMats[0];
                    mesh.userData._ppv = true;
                    mesh.userData._ppvMats = newMats;
                    overriddenMeshes.add(mesh);
                } else {
                    for (const m of mats) {
                        if (!m) continue;
                        if (m.opacity !== targetOp) m.opacity = targetOp;
                        if (m.color && m.color.getHex() !== targetCol) m.color.setHex(targetCol);
                        if (m.emissive && m.emissive.getHex() !== targetCol) m.emissive.setHex(targetCol);
                    }
                }
            });
        }
    }

    function restoreTransparency() {
        for (const mesh of overriddenMeshes) {
            try {
                if (origMats.has(mesh)) { mesh.material = origMats.get(mesh); origMats.delete(mesh); }
                if (mesh.userData._ppvMats) for (const m of mesh.userData._ppvMats) { try { m.dispose(); } catch {} }
                mesh.userData._ppv = false;
                delete mesh.userData._ppvMats;
            } catch {}
        }
        overriddenMeshes.clear();
        transparencyActive = false;
    }

    // ============ SKIN GIVER ============
    const RARITY_COLORS = {
        milspec: '#5a9bd4', restricted: '#7a5fd0', classified: '#c95fd0',
        covert: '#e05252', gold: '#ffd24a', contraband: '#ffd24a'
    };

    function findDataScript() {
        try {
            const resources = performance.getEntriesByType('resource').map(r => r.name);
            return resources.find(u => /\/src\/data-.*\.js/.test(u)) || null;
        } catch { return null; }
    }

    async function loadSkins() {
        if (settings.skin.cachedData && settings.skin.cachedData.length > 0) return settings.skin.cachedData;
        try {
            const cached = localStorage.getItem('watching_skins_cache');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.length) { settings.skin.cachedData = parsed; return parsed; }
            }
        } catch {}
        const dataUrl = findDataScript();
        if (!dataUrl) return null;
        try {
            const text = await (await fetch(dataUrl)).text();
            const regex = /\{id:`([^`]+)`,name:`([^`]+)`,slot:`([^`]+)`,kind:`([^`]+)`,kit:`([^`]+)`,rarity:`([^`]+)`,wmin:([0-9.]+),wmax:([0-9.]+),phase:`[^`]*`,img:`([^`]+)`/g;
            const arr = [];
            let m;
            while ((m = regex.exec(text)) && arr.length < 6000) {
                arr.push({ id: m[1], name: m[2], slot: m[3], kind: m[4], rarity: m[6], wmin: +m[7], wmax: +m[8], img: m[9] });
            }
            settings.skin.cachedData = arr;
            try { localStorage.setItem('watching_skins_cache', JSON.stringify(arr)); } catch {}
            return arr;
        } catch (e) { console.error('[Skin]', e); return null; }
    }

    async function searchSkins(query) {
        const container = document.getElementById('pp-skin-results');
        if (!container) return;
        query = (query || '').trim().toLowerCase();
        if (query.length < 2) {
            container.innerHTML = '<div class="pp-note" style="grid-column:1/-1;">Type 2+ letters...</div>';
            return;
        }
        container.innerHTML = '<div class="pp-note" style="grid-column:1/-1;">Searching...</div>';
        const all = await loadSkins();
        if (!all || !all.length) {
            container.innerHTML = '<div class="pp-note" style="grid-column:1/-1;color:#ff8888;">❌ data-*.js not found.</div>';
            return;
        }
        const filtered = all.filter(s => (s.name + ' ' + s.id).toLowerCase().includes(query));
        if (!filtered.length) {
            container.innerHTML = '<div class="pp-note" style="grid-column:1/-1;">Nothing found</div>';
            return;
        }
        const shown = filtered.slice(0, 30);
        container.innerHTML = filtered.length > 30
            ? `<div class="pp-note" style="grid-column:1/-1;">Showing 30 of ${filtered.length}</div>` : '';
        for (const skin of shown) {
            const card = document.createElement('div');
            card.className = 'pp-skin';
            const rc = RARITY_COLORS[skin.rarity] || '#8b5cf6';
            card.innerHTML = `
                <img src="https://community.cloudflare.steamstatic.com/economy/image/${skin.img}/64fx64f.webp"
                     loading="lazy" onerror="this.style.display='none'"
                     style="width:56px;height:42px;object-fit:contain;background:rgba(255,255,255,.04);border-radius:6px;">
                <div style="flex:1;min-width:0;overflow:hidden;">
                    <b style="color:${rc};display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;">${skin.name}</b>
                    <span style="font-size:9px;opacity:.5;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${skin.id}</span>
                </div>
                <button class="act" style="padding:4px 8px;font-size:10px;margin:0;">Give</button>
            `;
            card.querySelector('button').onclick = () => giveSkin(skin);
            container.appendChild(card);
        }
    }

    function giveSkin(skin) {
        try {
            const key = 'clutcher_inv_v1';
            const raw = localStorage.getItem(key);
            if (!raw) { alert('❌ No inventory found.'); return; }
            const inv = JSON.parse(raw);
            inv.items = inv.items || [];
            const uid = 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
            const wmin = isFinite(skin.wmin) ? skin.wmin : 0;
            const wmax = isFinite(skin.wmax) ? skin.wmax : 1;
            inv.items.push({
                uid, skin: skin.id,
                wear: +(wmin + (wmax - wmin) * 0.01).toFixed(6),
                seed: Math.floor(Math.random() * 1000),
                st: false, kills: 0, t: Date.now()
            });
            localStorage.setItem(key, JSON.stringify(inv));
            alert(`✅ ${skin.name} added!`);
        } catch (e) { alert('❌ ' + e.message); }
    }

    // ============ BUNNY HOP + SPEED HACK ============
    const moveState = { wasOnGround: true, origMaxSpeed: undefined };

    function isKeyPressed(game, code) {
        if (!code || code === '') return true;
        try {
            const input = game.input;
            if (!input) return false;
            if (code === 'Space') return !!input.space || (input.keys && input.keys.has('Space'));
            if (code === 'ShiftLeft') return input.keys && input.keys.has('ShiftLeft');
            if (code === 'ControlLeft') return input.keys && input.keys.has('ControlLeft');
            if (code === 'AltLeft') return input.keys && input.keys.has('AltLeft');
            if (code === 'Mouse1') return !!input.mouse1;
            if (code === 'Mouse2') return !!input.mouse2;
            return input.keys && input.keys.has(code);
        } catch { return false; }
    }

    function isJumpHeld(game, code) {
        try {
            const input = game.input;
            if (!input) return false;
            if (code === 'Space') {
                if (input.keys && input.keys.has('Space')) return true;
                if (input.space) return true;
            }
            return input.keys && input.keys.has(code);
        } catch { return false; }
    }

    function runMovement() {
        const game = window.game;
        if (!game || game.state !== 'playing') return;
        const player = game.player;
        if (!player || !player.alive) return;
        const mv = settings.player.movement;

        if (mv.speedEnabled && isKeyPressed(game, mv.speedKey)) {
            try {
                const weapons = game.weapons;
                if (weapons && typeof weapons.maxSpeed === 'function') {
                    if (moveState.origMaxSpeed === undefined) moveState.origMaxSpeed = weapons.maxSpeed.bind(weapons);
                    weapons.maxSpeed = function() {
                        const base = moveState.origMaxSpeed();
                        return base * mv.speedMultiplier;
                    };
                }
            } catch {}
        } else if (moveState.origMaxSpeed !== undefined) {
            try {
                const weapons = game.weapons;
                if (weapons && weapons.maxSpeed) weapons.maxSpeed = moveState.origMaxSpeed;
                moveState.origMaxSpeed = undefined;
            } catch {}
        }

        if (mv.bhopEnabled && isJumpHeld(game, mv.bhopKey)) {
            try {
                if (player.onGround) player.jumpBuffer = 0.12;
                player.stamina = 0;
                player.tagFactor = 1;
            } catch {}
            if (!player.onGround && !moveState.wasOnGround) {
                try {
                    const vx = player.vx || 0, vz = player.vz || 0;
                    const speed = Math.hypot(vx, vz);
                    if (speed > 0.5) {
                        const target = Math.min(speed * mv.bhopSpeed, mv.bhopMaxSpeed);
                        const factor = target / speed;
                        player.vx *= factor; player.vz *= factor;
                    }
                } catch {}
            }
        }
        moveState.wasOnGround = !!player.onGround;

        if (mv.strafeEnabled && !player.onGround) {
            try {
                const input = game.input;
                const keys = input && input.keys;
                if (keys) {
                    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
                    const right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
                    if (fwd || right) {
                        const yaw = player.yaw || 0;
                        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
                        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
                        let dx = fx * fwd + rx * right;
                        let dz = fz * fwd + rz * right;
                        const len = Math.hypot(dx, dz) || 1;
                        dx /= len; dz /= len;
                        let maxSpeed = 6.5;
                        try { maxSpeed = game.weapons?.maxSpeed?.() || 6.5; } catch {}
                        if (mv.speedEnabled && isKeyPressed(game, mv.speedKey)) maxSpeed *= mv.speedMultiplier;
                        player.vx += (dx * maxSpeed - player.vx) * mv.strafeStrength;
                        player.vz += (dz * maxSpeed - player.vz) * mv.strafeStrength;
                    }
                }
            } catch {}
        }

        if (mv.gravityEnabled && !player.onGround) {
            try {
                if (mv.gravityMultiplier !== 1) player.vy += (1 - mv.gravityMultiplier) * 20 / 60;
            } catch {}
        }
    }

    // ============================================================
    //              PROJECTILE DETECTION
    // ============================================================
    // Grenade / molotov / smoke / flash gibi projectile silahları tespit et
    function isProjectileWeapon(game) {
        try {
            const w = game.weapons;
            if (!w) return false;
            const def = w.def ? w.def() : null;
            const cur = w.current;
            if (!cur && !def) return false;

            const id = (cur || def?.id || def?.name || '').toLowerCase();
            const cls = (def?.class || def?.kind || '').toLowerCase();
            const name = (def?.name || '').toLowerCase();

            // Yaygın projectile isimleri
            const projectileNames = [
                'grenade', 'hegrenade', 'he_grenade', 'frag',
                'molotov', 'incgrenade', 'incendiary',
                'smoke', 'smokegrenade', 'flash', 'flashbang',
                'decoy', 'nade', 'grenade_he'
            ];
            const projectileClasses = ['grenade', 'projectile', 'throwable', 'nade'];

            for (const n of projectileNames) {
                if (id.includes(n) || name.includes(n) || cls.includes(n)) return true;
            }
            for (const c of projectileClasses) {
                if (cls.includes(c) || id.includes(c)) return true;
            }

            // Slot kontrolü (grenade slot 4)
            if (def?.slot === 4 || def?.slot === 'grenade' || def?.slot === 'Grenade') return true;

            return false;
        } catch { return false; }
    }

    // ============================================================
    //                  MODERN BLACK GUI
    // ============================================================
    const GUI_CSS = `
        #pp-root, #pp-root * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
        #pp-root {
            position: fixed; left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 760px; height: 520px;
            max-width: 95vw; max-height: 95vh;
            background: linear-gradient(160deg, #000000 0%, #0a0a0a 55%, #111111 100%);
            border: 1px solid #8b5cf6; border-radius: 14px;
            color: #e8e8f0; font-size: 13px;
            z-index: 2147483647;
            display: flex; overflow: hidden;
            box-shadow: 0 0 60px rgba(139,92,246,.4), 0 20px 60px rgba(0,0,0,.9);
            opacity: 1; visibility: visible; pointer-events: auto;
            isolation: isolate;
        }
        #pp-root.pp-hidden { display: none !important; }
        #pp-root.dragging { transform: none !important; }
        #pp-title {
            position: absolute; top: 0; left: 0; right: 0; height: 38px;
            z-index: 10; background: rgba(0,0,0,0.97);
            display: flex; align-items: center; padding: 0 14px;
            font-weight: 900; letter-spacing: 3px;
            color: #c4b5fd;
            border-bottom: 1px solid rgba(139,92,246,.5);
            font-size: 13px; cursor: move; user-select: none;
        }
        #pp-title .pp-logo {
            width: 22px; height: 22px; margin-right: 8px;
            border-radius: 5px;
            background: linear-gradient(135deg, #8b5cf6, #6d28d9);
            box-shadow: 0 0 10px rgba(139,92,246,.7);
        }
        #pp-title .pp-title-text { flex: 1; }
        #pp-title .pp-btn {
            background: transparent; border: none;
            color: #c4b5fd; cursor: pointer;
            font-size: 18px; font-weight: 700;
            padding: 0 10px; line-height: 1;
            transition: color .15s, text-shadow .15s;
            pointer-events: auto;
            user-select: none;
        }
        #pp-title .pp-btn:hover { color: #fff; }
        #pp-title .pp-min { color: #22d3ee; font-size: 22px; }
        #pp-title .pp-min:hover { color: #67e8f9; text-shadow: 0 0 8px #22d3ee; }
        #pp-title .pp-close { color: #ff6b6b; }
        #pp-title .pp-close:hover { color: #ff9b9b; text-shadow: 0 0 8px #ff6b6b; }
        #pp-tabs {
            width: 165px; flex-shrink: 0;
            background: rgba(0,0,0,.6);
            padding: 46px 8px 10px;
            display: flex; flex-direction: column; gap: 4px;
            border-right: 1px solid rgba(139,92,246,.2);
            overflow-y: auto;
        }
        #pp-tabs::-webkit-scrollbar { width: 4px; }
        #pp-tabs::-webkit-scrollbar-thumb { background: rgba(139,92,246,.3); border-radius: 2px; }
        #pp-tabs button {
            background: transparent; border: 1px solid transparent;
            color: #9a8fc0; padding: 9px 10px;
            border-radius: 8px; cursor: pointer;
            text-align: left; font-weight: 600; font-size: 12px;
            transition: all .2s ease;
        }
        #pp-tabs button:hover { background: rgba(139,92,246,.15); color: #fff; }
        #pp-tabs button.sel {
            background: rgba(139,92,246,.3);
            border-color: #8b5cf6; color: #fff;
        }
        #pp-body {
            flex: 1; padding: 46px 16px 16px;
            overflow-y: auto; overflow-x: hidden; min-width: 0;
        }
        #pp-body::-webkit-scrollbar { width: 6px; }
        #pp-body::-webkit-scrollbar-thumb { background: rgba(139,92,246,.4); border-radius: 3px; }
        #pp-body .pp-row {
            margin: 6px 0; display: flex;
            align-items: center; justify-content: space-between;
            gap: 10px; padding: 6px 4px;
            border-bottom: 1px solid rgba(255,255,255,.04);
        }
        #pp-body .pp-row > span:first-child { color: #d0c8e8; flex: 1; min-width: 0; }
        #pp-body .pp-header {
            margin: 14px 0 6px;
            font-size: 10px; color: #8b5cf6;
            letter-spacing: 2px; font-weight: 800;
            text-transform: uppercase;
            border-bottom: 1px solid rgba(139,92,246,.25);
            padding-bottom: 4px;
        }
        #pp-body .pp-note { opacity: .55; font-size: 11px; color: #9a8fc0; display: block; line-height: 1.4; }
        #pp-body button.act {
            background: #8b5cf6; border: none; color: #fff;
            padding: 8px 12px; border-radius: 8px;
            cursor: pointer; font-weight: 700; font-size: 12px;
        }
        #pp-body button.act:hover { background: #a78bfa; }
        #pp-body input[type=checkbox] {
            -webkit-appearance: none; appearance: none;
            width: 38px; height: 20px; border-radius: 11px;
            background: rgba(255,255,255,.12);
            position: relative; cursor: pointer; margin: 0;
            flex: 0 0 auto; border: 1px solid rgba(255,255,255,.08);
        }
        #pp-body input[type=checkbox]::after {
            content: ''; position: absolute;
            top: 2px; left: 2px; width: 14px; height: 14px;
            border-radius: 50%; background: #fff;
            transition: left .25s cubic-bezier(.3,1.4,.5,1);
        }
        #pp-body input[type=checkbox]:checked { background: #8b5cf6; }
        #pp-body input[type=checkbox]:checked::after { left: 20px; }
        #pp-body input[type=range] {
            -webkit-appearance: none; appearance: none;
            width: 140px; height: 4px;
            background: rgba(255,255,255,.1);
            border-radius: 2px; outline: none;
            cursor: pointer; flex: 0 0 auto;
        }
        #pp-body input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 14px; height: 14px; border-radius: 50%;
            background: #8b5cf6; cursor: pointer;
        }
        #pp-body input[type=color] {
            -webkit-appearance: none; appearance: none;
            border: none; background: none; padding: 0;
            width: 34px; height: 24px; cursor: pointer;
            border-radius: 6px; overflow: hidden;
            flex: 0 0 auto;
        }
        #pp-body input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
        #pp-body input[type=color]::-webkit-color-swatch {
            border: 1px solid rgba(139,92,246,.5); border-radius: 6px;
        }
        #pp-body input[type=text], #pp-body input[type=number] {
            background: rgba(255,255,255,.06); color: #fff;
            border: 1px solid rgba(139,92,246,.3);
            border-radius: 6px; padding: 6px 10px;
            font: inherit; font-size: 12px; outline: none;
            width: 100%; box-sizing: border-box;
        }
        .pp-dd { position: relative; display: inline-block; flex: 0 0 auto; }
        .pp-dd-btn {
            background: rgba(255,255,255,.06);
            color: #c4b5fd;
            border: 1px solid rgba(139,92,246,.3);
            border-radius: 6px;
            padding: 5px 26px 5px 10px;
            cursor: pointer; font: inherit; font-size: 12px;
            min-width: 100px; text-align: left; position: relative;
        }
        .pp-dd-btn::after {
            content: '▾'; position: absolute;
            right: 8px; top: 50%;
            transform: translateY(-50%);
            opacity: .7; font-size: 10px; pointer-events: none;
        }
        .pp-dd-list {
            position: absolute; top: calc(100% + 4px); left: 0;
            min-width: 100%; background: #0a0a0a;
            border: 1px solid #8b5cf6; border-radius: 8px;
            overflow: hidden; z-index: 100;
            opacity: 0; transform: translateY(-6px); pointer-events: none;
            transition: opacity .18s ease, transform .22s ease;
            box-shadow: 0 8px 24px rgba(0,0,0,.8);
            max-height: 220px; overflow-y: auto;
        }
        .pp-dd-list.open { opacity: 1; transform: none; pointer-events: auto; }
        .pp-dd-item {
            padding: 7px 12px; cursor: pointer;
            color: #c4b5fd; font-size: 12px; white-space: nowrap;
        }
        .pp-dd-item:hover { background: rgba(139,92,246,.25); color: #fff; }
        .pp-dd-item.sel { background: rgba(139,92,246,.4); color: #fff; font-weight: 700; }
        .pp-keybind {
            background: rgba(139,92,246,.15); color: #c4b5fd;
            border: 1px solid rgba(139,92,246,.3);
            border-radius: 6px; padding: 5px 10px;
            cursor: pointer; font-size: 12px; font-weight: 600;
            min-width: 80px;
        }
        .pp-skin {
            display: flex; align-items: center; gap: 8px;
            background: rgba(0,0,0,.4);
            border: 1px solid rgba(139,92,246,.25);
            border-radius: 8px; padding: 6px;
        }
        #pp-skin-results {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 6px; max-height: 320px; overflow-y: auto; padding: 4px;
        }
        #pp-vmfov-status {
            font-size: 10px; color: #22d3ee;
            padding: 3px 6px; background: rgba(34,211,238,.1);
            border-radius: 4px; margin-top: 4px; display: block;
        }
        #pp-tp-status {
            font-size: 10px; color: #22c55e;
            padding: 3px 6px; background: rgba(34,197,94,.1);
            border-radius: 4px; margin-top: 4px; display: block;
        }
        #pp-proj-status {
            font-size: 10px; color: #ff8033;
            padding: 3px 6px; background: rgba(255,128,51,.1);
            border-radius: 4px; margin-top: 4px; display: block;
        }

        /* ============ MINI ICON ============ */
        #pp-mini-icon {
            position: fixed; right: 20px; top: 20px;
            width: 52px; height: 52px;
            border-radius: 50%;
            background: linear-gradient(135deg, #8b5cf6, #6d28d9);
            border: 2px solid #c4b5fd;
            display: none;
            align-items: center; justify-content: center;
            cursor: pointer;
            z-index: 2147483646;
            box-shadow: 0 0 20px rgba(139,92,246,.8), 0 4px 16px rgba(0,0,0,.8);
            transition: transform .15s ease, box-shadow .15s ease;
            user-select: none;
            font-size: 24px; color: #fff;
            font-weight: 900;
            animation: pp-pulse 2.2s ease-in-out infinite;
            pointer-events: auto;
        }
        #pp-mini-icon.show { display: flex; }
        #pp-mini-icon:hover {
            transform: scale(1.1);
            box-shadow: 0 0 30px rgba(139,92,246,1), 0 4px 20px rgba(0,0,0,.9);
        }
        #pp-mini-icon::before {
            content: 'W';
            text-shadow: 0 0 8px rgba(255,255,255,.6);
        }
        @keyframes pp-pulse {
            0%, 100% { box-shadow: 0 0 20px rgba(139,92,246,.8), 0 4px 16px rgba(0,0,0,.8); }
            50% { box-shadow: 0 0 32px rgba(139,92,246,1), 0 4px 16px rgba(0,0,0,.8); }
        }
        #pp-mini-icon .pp-mini-badge {
            position: absolute; top: -3px; right: -3px;
            width: 14px; height: 14px; border-radius: 50%;
            background: #22c55e;
            border: 2px solid #000;
            box-shadow: 0 0 8px #22c55e;
        }
    `;

    const styleEl = document.createElement('style');
    styleEl.id = 'pp-root-style';
    styleEl.textContent = GUI_CSS;
    document.head.appendChild(styleEl);

    const gui = document.createElement('div');
    gui.id = 'pp-root';
    gui.innerHTML = `
        <div id="pp-title">
            <span class="pp-logo"></span>
            <span class="pp-title-text">WATCHING v51.3</span>
            <button class="pp-btn pp-min" title="Minimize (P)" type="button">➖</button>
            <button class="pp-btn pp-close" title="Close" type="button">✕</button>
        </div>
        <div id="pp-tabs"></div>
        <div id="pp-body"></div>
    `;
    document.body.appendChild(gui);

    const miniIcon = document.createElement('div');
    miniIcon.id = 'pp-mini-icon';
    miniIcon.title = 'Open WATCHING (P)';
    miniIcon.innerHTML = '<span class="pp-mini-badge"></span>';
    document.body.appendChild(miniIcon);

    const tabsEl = gui.querySelector('#pp-tabs');
    const bodyEl = gui.querySelector('#pp-body');

    const TABS = [
        ['esp', 'ESP'],
        ['aim', 'Aimbot'],
        ['visual', 'Visuals'],
        ['player', 'Player'],
        ['effects', 'Effects'],
        ['skins', '🎨 Skins'],
        ['tools', 'Tools']
    ];
    const tabPanels = {};
    let currentTab = 'esp';

    for (const [id, label] of TABS) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.dataset.tab = id;
        if (id === currentTab) btn.classList.add('sel');
        btn.onclick = () => switchTab(id);
        tabsEl.appendChild(btn);

        const panel = document.createElement('div');
        panel.style.display = id === currentTab ? 'block' : 'none';
        bodyEl.appendChild(panel);
        tabPanels[id] = panel;
    }

    function switchTab(id) {
        currentTab = id;
        for (const btn of tabsEl.querySelectorAll('button')) {
            btn.classList.toggle('sel', btn.dataset.tab === id);
        }
        for (const key in tabPanels) {
            tabPanels[key].style.display = key === id ? 'block' : 'none';
        }
    }

    // ============================================================
    //  GUI STATE
    // ============================================================
    let guiMode = 'open';

    function setModeOpen() {
        guiMode = 'open';
        gui.classList.remove('pp-hidden');
        gui.style.setProperty('display', 'flex', 'important');
        miniIcon.classList.remove('show');
    }
    function setModeHidden() {
        guiMode = 'hidden';
        gui.classList.add('pp-hidden');
        gui.style.setProperty('display', 'none', 'important');
        miniIcon.classList.remove('show');
    }
    function setModeMini() {
        guiMode = 'mini';
        gui.classList.add('pp-hidden');
        gui.style.setProperty('display', 'none', 'important');
        miniIcon.classList.add('show');
    }

    function toggleGUI() {
        if (guiMode === 'open') setModeMini();
        else setModeOpen();
    }

    const minBtn = gui.querySelector('.pp-min');
    minBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setModeMini();
    }, true);
    minBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (guiMode !== 'mini') setModeMini();
    }, true);

    const closeBtn = gui.querySelector('.pp-close');
    closeBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setModeHidden();
    }, true);
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (guiMode !== 'hidden') setModeHidden();
    }, true);

    let miniDownAt = 0;
    miniIcon.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        miniDownAt = performance.now();
    }, true);
    miniIcon.addEventListener('pointerup', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (performance.now() - miniDownAt < 400) {
            setModeOpen();
        }
    }, true);
    miniIcon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (guiMode !== 'open') setModeOpen();
    }, true);

    function onKeyP(e) {
        if (e.code !== 'KeyP' && e.key !== 'p' && e.key !== 'P') return;
        if (e.repeat) return;

        const tag = (e.target && e.target.tagName) || '';
        const active = document.activeElement;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

        e.preventDefault();
        e.stopPropagation();
        toggleGUI();
    }

    window.addEventListener('keydown', onKeyP, true);

    new MutationObserver(() => {
        if (guiMode !== 'open') return;
        if (gui.style.display === 'none') gui.style.setProperty('display', 'flex', 'important');
    }).observe(gui, { attributes: true, attributeFilter: ['class', 'style'] });

    // ============ DRAGGABLE ============
    (function makeDraggable() {
        const titleEl = gui.querySelector('#pp-title');
        let isDragging = false, offsetX = 0, offsetY = 0;

        titleEl.addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('pp-close')) return;
            if (e.target.classList.contains('pp-min')) return;
            if (e.button !== 0) return;
            isDragging = true;
            const rect = gui.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            gui.classList.add('dragging');
            gui.style.left = rect.left + 'px';
            gui.style.top = rect.top + 'px';
            gui.style.transform = 'none';
            try { titleEl.setPointerCapture(e.pointerId); } catch {}
            e.preventDefault();
        });
        titleEl.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            let x = e.clientX - offsetX;
            let y = e.clientY - offsetY;
            x = Math.max(0, Math.min(innerWidth - gui.offsetWidth, x));
            y = Math.max(0, Math.min(innerHeight - gui.offsetHeight, y));
            gui.style.left = x + 'px';
            gui.style.top = y + 'px';
        });
        const endDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            gui.classList.remove('dragging');
            try { titleEl.releasePointerCapture(e.pointerId); } catch {}
        };
        titleEl.addEventListener('pointerup', endDrag);
        titleEl.addEventListener('pointercancel', endDrag);
    })();

    // ============ HELPERS ============
    function makeRow(label, ...children) {
        const row = document.createElement('div');
        row.className = 'pp-row';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        row.appendChild(lbl);
        for (const c of children) row.appendChild(c);
        return row;
    }
    function makeHeader(text) {
        const h = document.createElement('div');
        h.className = 'pp-header';
        h.textContent = text;
        return h;
    }
    function makeToggle(label, getVal, setVal) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = getVal();
        cb.onchange = () => setVal(cb.checked);
        return makeRow(label, cb);
    }
    function makeSlider(label, min, max, step, getVal, setVal) {
        const wrap = document.createElement('div');
        wrap.className = 'pp-row';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        const right = document.createElement('div');
        right.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min; slider.max = max; slider.step = step;
        slider.value = getVal();
        const val = document.createElement('span');
        val.textContent = getVal();
        val.style.cssText = 'color:#8b5cf6;font-weight:700;min-width:36px;text-align:right;';
        slider.oninput = () => { val.textContent = slider.value; setVal(parseFloat(slider.value)); };
        right.appendChild(slider);
        right.appendChild(val);
        wrap.appendChild(lbl);
        wrap.appendChild(right);
        return wrap;
    }
    function makeColorPicker(label, getVal, setVal) {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = getVal();
        input.oninput = () => setVal(input.value);
        return makeRow(label, input);
    }
    function makeDropdown(label, options, getVal, setVal) {
        const wrap = document.createElement('div');
        wrap.className = 'pp-row';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        const dd = document.createElement('div');
        dd.className = 'pp-dd';
        const btn = document.createElement('button');
        btn.className = 'pp-dd-btn';
        const list = document.createElement('div');
        list.className = 'pp-dd-list';
        let open = false;
        function setBtnText() {
            const cur = options.find(o => o.value === getVal());
            btn.textContent = cur ? cur.label : getVal();
        }
        setBtnText();
        for (const opt of options) {
            const item = document.createElement('div');
            item.className = 'pp-dd-item';
            item.textContent = opt.label;
            if (opt.value === getVal()) item.classList.add('sel');
            item.onclick = (e) => {
                e.stopPropagation();
                setVal(opt.value);
                for (const it of list.children) it.classList.remove('sel');
                item.classList.add('sel');
                setBtnText();
                close();
            };
            list.appendChild(item);
        }
        function close() { list.classList.remove('open'); open = false; }
        function toggle() {
            if (open) close();
            else {
                document.querySelectorAll('.pp-dd-list.open').forEach(l => l.classList.remove('open'));
                list.classList.add('open');
                open = true;
            }
        }
        btn.onclick = (e) => { e.stopPropagation(); toggle(); };
        document.addEventListener('click', (e) => {
            if (!dd.contains(e.target)) close();
        });
        dd.appendChild(btn);
        dd.appendChild(list);
        wrap.appendChild(lbl);
        wrap.appendChild(dd);
        return wrap;
    }
    function makeKeybind(label, getVal, setVal) {
        const wrap = document.createElement('div');
        wrap.className = 'pp-row';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        const btn = document.createElement('button');
        btn.className = 'pp-keybind';
        const fmt = (code) => {
            if (!code) return 'Always On';
            return String(code).replace(/^Key/, '').replace(/^Digit/, '');
        };
        btn.textContent = fmt(getVal());
        let capturing = false;
        let activeHandler = null;

        btn.onclick = (e) => {
            e.stopPropagation();
            if (capturing) return;
            capturing = true;
            btn.textContent = '...';

            activeHandler = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                capturing = false;
                document.removeEventListener('keydown', activeHandler, true);
                activeHandler = null;
                if (ev.code === 'Escape' || ev.code === 'Backspace') {
                    setVal('');
                    btn.textContent = 'Always On';
                } else {
                    setVal(ev.code);
                    btn.textContent = fmt(ev.code);
                }
            };
            document.addEventListener('keydown', activeHandler, true);
        };

        wrap.appendChild(lbl);
        wrap.appendChild(btn);
        return wrap;
    }
    function makeButton(label, onClick) {
        const btn = document.createElement('button');
        btn.className = 'act';
        btn.textContent = label;
        btn.style.cssText = 'display:block;width:100%;margin-top:10px;';
        btn.onclick = onClick;
        return btn;
    }

    // ============================================================
    //                        ESP TAB
    // ============================================================
    const esp = settings.esp;
    const espPanel = tabPanels.esp;

    const espMasterWrap = document.createElement('div');
    espMasterWrap.className = 'pp-row';
    espMasterWrap.style.cssText = 'background:rgba(139,92,246,.15);border:1px solid #8b5cf6;border-radius:8px;padding:10px;margin-bottom:10px;';
    const espMasterLbl = document.createElement('span');
    espMasterLbl.textContent = '⚡ ESP MASTER';
    espMasterLbl.style.cssText = 'font-weight:800;color:#c4b5fd;letter-spacing:1px;';
    const espMasterCb = document.createElement('input');
    espMasterCb.type = 'checkbox';
    espMasterCb.checked = esp.enabled;
    espMasterCb.onchange = () => esp.enabled = espMasterCb.checked;
    espMasterWrap.appendChild(espMasterLbl);
    espMasterWrap.appendChild(espMasterCb);
    espPanel.appendChild(espMasterWrap);

    espPanel.appendChild(makeHeader('TARGETS'));
    espPanel.appendChild(makeToggle('Show Enemies', () => esp.showEnemy, v => esp.showEnemy = v));
    espPanel.appendChild(makeToggle('Show Teammates', () => esp.showTeam, v => esp.showTeam = v));
    espPanel.appendChild(makeHeader('INFO'));
    espPanel.appendChild(makeToggle('Show Name', () => esp.showName, v => esp.showName = v));
    espPanel.appendChild(makeToggle('Show Health', () => esp.showHealth, v => esp.showHealth = v));
    espPanel.appendChild(makeToggle('Show Distance', () => esp.showDistance, v => esp.showDistance = v));
    espPanel.appendChild(makeHeader('BOX STYLE'));
    espPanel.appendChild(makeToggle('Filled Box', () => esp.filled, v => esp.filled = v));
    espPanel.appendChild(makeToggle('Corner Box', () => esp.corners, v => esp.corners = v));
    espPanel.appendChild(makeToggle('Snapline', () => esp.snapline, v => esp.snapline = v));
    espPanel.appendChild(makeToggle('Offscreen Arrows', () => esp.offscreen, v => esp.offscreen = v));
    espPanel.appendChild(makeHeader('SKELETON'));
    espPanel.appendChild(makeToggle('Skeleton ESP', () => esp.skeleton, v => esp.skeleton = v));
    espPanel.appendChild(makeHeader('WALLHACK'));
    espPanel.appendChild(makeToggle('Glow Enabled', () => esp.glow, v => {
        esp.glow = v;
        if (!v) restoreGlow();
    }));

    // ============================================================
    //                       AIMBOT TAB
    // ============================================================
    const aim = settings.aim;
    const aimPanel = tabPanels.aim;

    const aimMasterWrap = document.createElement('div');
    aimMasterWrap.className = 'pp-row';
    aimMasterWrap.style.cssText = 'background:rgba(255,80,80,.15);border:1px solid #ff5050;border-radius:8px;padding:10px;margin-bottom:10px;';
    const aimMasterLbl = document.createElement('span');
    aimMasterLbl.textContent = '🎯 AIMBOT MASTER';
    aimMasterLbl.style.cssText = 'font-weight:800;color:#ff8080;letter-spacing:1px;';
    const aimMasterCb = document.createElement('input');
    aimMasterCb.type = 'checkbox';
    aimMasterCb.checked = aim.enabled;
    aimMasterCb.onchange = () => aim.enabled = aimMasterCb.checked;
    aimMasterWrap.appendChild(aimMasterLbl);
    aimMasterWrap.appendChild(aimMasterCb);
    aimPanel.appendChild(aimMasterWrap);

    aimPanel.appendChild(makeHeader('⚡ ACTIVATION MODE'));
    const alwaysOnRow = document.createElement('label');
    alwaysOnRow.className = 'pp-row';
    alwaysOnRow.style.cssText = 'background:rgba(255,150,0,.12);border:1px solid rgba(255,150,0,.4);border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;';
    const alwaysOnLbl = document.createElement('span');
    alwaysOnLbl.textContent = '⚡ ALWAYS ON (no key needed)';
    alwaysOnLbl.style.cssText = 'font-weight:700;color:#ffb340;';
    const alwaysOnCb = document.createElement('input');
    alwaysOnCb.type = 'checkbox';
    alwaysOnCb.checked = aim.alwaysOn;
    alwaysOnCb.style.cssText = 'accent-color:#ffb340;';
    alwaysOnCb.onchange = () => aim.alwaysOn = alwaysOnCb.checked;
    alwaysOnRow.appendChild(alwaysOnLbl);
    alwaysOnRow.appendChild(alwaysOnCb);
    aimPanel.appendChild(alwaysOnRow);

    aimPanel.appendChild(makeHeader('OR KEYBIND'));
    aimPanel.appendChild(makeKeybind('Custom Key (hold)', () => aim.key || '', v => aim.key = v || null));

    aimPanel.appendChild(makeHeader('AIM SETTINGS'));
    aimPanel.appendChild(makeSlider('FOV (degrees)', 1, 90, 1, () => aim.fov, v => { aim.fov = v; }));
    aimPanel.appendChild(makeSlider('Smooth', 1, 30, 1, () => aim.smooth, v => { aim.smooth = v; }));
    aimPanel.appendChild(makeSlider('Max Distance', 10, 500, 5, () => aim.maxDist, v => { aim.maxDist = v; }));
    aimPanel.appendChild(makeDropdown('Target Bone', [
        { value: 'head', label: 'Head' },
        { value: 'neck', label: 'Neck' },
        { value: 'chest', label: 'Chest' },
        { value: 'stomach', label: 'Stomach' }
    ], () => aim.targetBone, v => { aim.targetBone = v; }));
    aimPanel.appendChild(makeHeader('FILTERS'));
    aimPanel.appendChild(makeToggle('Team Check', () => aim.teamCheck, v => aim.teamCheck = v));
    aimPanel.appendChild(makeToggle('Visible Only', () => aim.visibleOnly, v => aim.visibleOnly = v));
    aimPanel.appendChild(makeToggle('Draw FOV Circle', () => aim.drawFov, v => aim.drawFov = v));

    // ---- PROJECTILE AIM ----
    aimPanel.appendChild(makeHeader('💣 PROJECTILE AIM (Grenade / Molotov)'));
    const projRow = document.createElement('label');
    projRow.className = 'pp-row';
    projRow.style.cssText = 'background:rgba(255,128,51,.12);border:1px solid rgba(255,128,51,.5);border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;';
    const projLbl = document.createElement('span');
    projLbl.textContent = '💣 Snap to Target (Grenade/Molotov)';
    projLbl.style.cssText = 'font-weight:700;color:#ff8033;';
    const projCb = document.createElement('input');
    projCb.type = 'checkbox';
    projCb.checked = aim.projectileSnap;
    projCb.style.cssText = 'accent-color:#ff8033;';
    projCb.onchange = () => aim.projectileSnap = projCb.checked;
    projRow.appendChild(projLbl);
    projRow.appendChild(projCb);
    aimPanel.appendChild(projRow);

    const projStatus = document.createElement('div');
    projStatus.id = 'pp-proj-status';
    projStatus.textContent = 'ℹ️ Grenade/molotov atarken tam hedefe kilitlenir';
    aimPanel.appendChild(projStatus);

    aimPanel.appendChild(makeDropdown('Projectile Target Bone', [
        { value: 'head', label: 'Head (üst)' },
        { value: 'neck', label: 'Neck' },
        { value: 'chest', label: 'Chest (orta)' },
        { value: 'stomach', label: 'Stomach (alt)' },
        { value: 'feet', label: 'Feet (yer)' }
    ], () => aim.projectileBone, v => { aim.projectileBone = v; }));

    // ============================================================
    //                       VISUALS TAB
    // ============================================================
    const visual = settings.visual;
    const visualPanel = tabPanels.visual;

    visualPanel.appendChild(makeHeader('WEAPON CONTROL'));
    visualPanel.appendChild(makeToggle('No Recoil', () => visual.noRecoil, v => visual.noRecoil = v));
    visualPanel.appendChild(makeToggle('No Spread', () => visual.noSpread, v => visual.noSpread = v));
    visualPanel.appendChild(makeToggle('No Spread (Aggressive)', () => visual.noSpreadAggressive, v => {
        visual.noSpreadAggressive = v;
        if (v) installAggressiveNoSpread(); else uninstallAggressiveNoSpread();
    }));

    visualPanel.appendChild(makeHeader('👤 THIRD PERSON'));
    const tpRow = document.createElement('label');
    tpRow.className = 'pp-row';
    tpRow.style.cssText = 'background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.4);border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;';
    const tpLbl = document.createElement('span');
    tpLbl.textContent = '👤 Enable Third Person';
    tpLbl.style.cssText = 'font-weight:700;color:#22c55e;';
    const tpCb = document.createElement('input');
    tpCb.type = 'checkbox';
    tpCb.checked = visual.thirdPerson;
    tpCb.style.cssText = 'accent-color:#22c55e;';
    tpCb.onchange = () => {
        visual.thirdPerson = tpCb.checked;
        if (!tpCb.checked) {
            restoreViewModelVisibility();
            cleanupThirdPersonModel();
        }
    };
    tpRow.appendChild(tpLbl);
    tpRow.appendChild(tpCb);
    visualPanel.appendChild(tpRow);

    visualPanel.appendChild(makeSlider('Distance', 1, 6, 0.1,
        () => visual.thirdPersonDist, v => { visual.thirdPersonDist = v; }));

    visualPanel.appendChild(makeToggle('Show Character Model',
        () => visual.thirdPersonShowModel, v => {
            visual.thirdPersonShowModel = v;
            if (!v) cleanupThirdPersonModel();
        }));

    visualPanel.appendChild(makeToggle('Hide ViewModel',
        () => visual.thirdPersonHideVM, v => visual.thirdPersonHideVM = v));

    const tpStatus = document.createElement('div');
    tpStatus.id = 'pp-tp-status';
    tpStatus.textContent = '⏸ Disabled';
    visualPanel.appendChild(tpStatus);

    visualPanel.appendChild(makeHeader('🎥 VIEWMODEL FOV'));
    const vmFovRow = document.createElement('label');
    vmFovRow.className = 'pp-row';
    vmFovRow.style.cssText = 'background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.4);border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;';
    const vmFovLbl = document.createElement('span');
    vmFovLbl.textContent = '🎥 Enable ViewModel FOV';
    vmFovLbl.style.cssText = 'font-weight:700;color:#22d3ee;';
    const vmFovCb = document.createElement('input');
    vmFovCb.type = 'checkbox';
    vmFovCb.checked = visual.vmFovEnabled;
    vmFovCb.style.cssText = 'accent-color:#22d3ee;';
    vmFovCb.onchange = () => {
        visual.vmFovEnabled = vmFovCb.checked;
        if (!vmFovCb.checked) restoreViewModelFov();
    };
    vmFovRow.appendChild(vmFovLbl);
    vmFovRow.appendChild(vmFovCb);
    visualPanel.appendChild(vmFovRow);

    visualPanel.appendChild(makeSlider('ViewModel FOV Value', 30, 120, 1,
        () => visual.vmFovValue, v => { visual.vmFovValue = v; }));

    visualPanel.appendChild(makeDropdown('Preset', [
        { value: 'default', label: 'Default (68)' },
        { value: 'close', label: 'Close (50)' },
        { value: 'classic', label: 'Classic CS (54)' },
        { value: 'wide', label: 'Wide (90)' },
        { value: 'ultra', label: 'Ultra Wide (110)' },
        { value: 'low', label: 'Very Close (40)' }
    ], () => visual.vmFovPreset, v => {
        visual.vmFovPreset = v;
        visual.vmFovValue = VM_FOV_PRESETS[v] || 68;
    }));

    const vmfovStatus = document.createElement('div');
    vmfovStatus.id = 'pp-vmfov-status';
    vmfovStatus.textContent = 'ℹ️ Waiting...';
    visualPanel.appendChild(vmfovStatus);

    visualPanel.appendChild(makeHeader('FOV CHANGER (WORLD)'));
    visualPanel.appendChild(makeToggle('FOV Changer', () => visual.fovChanger, v => {
        visual.fovChanger = v;
        if (!v) restoreFov();
    }));
    visualPanel.appendChild(makeSlider('FOV Value', 30, 180, 1, () => visual.fovValue, v => { visual.fovValue = v; }));

    visualPanel.appendChild(makeHeader('ASPECT RATIO'));
    visualPanel.appendChild(makeToggle('Aspect Ratio Enabled', () => visual.aspectEnabled, v => {
        visual.aspectEnabled = v;
        if (!v) restoreAspect();
    }));
    visualPanel.appendChild(makeDropdown('Aspect Ratio', [
        { value: '16:9', label: '16:9 (Native)' },
        { value: '1:1', label: '1:1 (Square)' },
        { value: '4:3', label: '4:3 (Classic)' },
        { value: '5:4', label: '5:4' },
        { value: '16:10', label: '16:10' },
        { value: '21:9', label: '21:9 (Ultrawide)' }
    ], () => visual.aspectRatio, v => {
        visual.aspectRatio = v;
        if (visual.aspectEnabled) applyAspect();
    }));

    visualPanel.appendChild(makeHeader('TRANSPARENCY'));
    visualPanel.appendChild(makeSlider('Weapon Opacity', 0, 1, 0.05, () => visual.weaponOpacity, v => { visual.weaponOpacity = v; }));
    visualPanel.appendChild(makeColorPicker('Weapon Color', () => visual.weaponColor, v => visual.weaponColor = v));
    visualPanel.appendChild(makeSlider('Hands Opacity', 0, 1, 0.05, () => visual.handsOpacity, v => { visual.handsOpacity = v; }));
    visualPanel.appendChild(makeColorPicker('Hands Color', () => visual.handsColor, v => visual.handsColor = v));
    visualPanel.appendChild(makeButton('Reset Transparency', () => {
        visual.weaponOpacity = 1.0;
        visual.handsOpacity = 1.0;
        visual.weaponColor = '#8b5cf6';
        visual.handsColor = '#22d3ee';
        restoreTransparency();
        switchTab('visual');
    }));

    // ============================================================
    //                       PLAYER TAB
    // ============================================================
    const playerSet = settings.player;
    const mv = playerSet.movement;
    const playerPanel = tabPanels.player;

    playerPanel.appendChild(makeHeader('WEAPON'));
    playerPanel.appendChild(makeToggle('Infinite Ammo', () => playerSet.infAmmo, v => playerSet.infAmmo = v));
    playerPanel.appendChild(makeToggle('No Reload', () => playerSet.noReload, v => playerSet.noReload = v));

    playerPanel.appendChild(makeHeader('🏃 BUNNY HOP'));
    playerPanel.appendChild(makeToggle('🐰 Bunny Hop (Auto Jump)', () => mv.bhopEnabled, v => mv.bhopEnabled = v));
    playerPanel.appendChild(makeKeybind('Bhop Key', () => mv.bhopKey, v => mv.bhopKey = v || 'Space'));
    playerPanel.appendChild(makeSlider('Bhop Speed Boost', 1.0, 1.5, 0.01, () => mv.bhopSpeed, v => { mv.bhopSpeed = v; }));
    playerPanel.appendChild(makeSlider('Bhop Max Speed', 5, 20, 0.5, () => mv.bhopMaxSpeed, v => { mv.bhopMaxSpeed = v; }));

    playerPanel.appendChild(makeHeader('🌀 AUTO STRAFE'));
    playerPanel.appendChild(makeToggle('Auto Strafe (in air)', () => mv.strafeEnabled, v => mv.strafeEnabled = v));
    playerPanel.appendChild(makeSlider('Strafe Strength', 0.1, 1.0, 0.05, () => mv.strafeStrength, v => { mv.strafeStrength = v; }));

    playerPanel.appendChild(makeHeader('⚡ SPEED HACK'));
    playerPanel.appendChild(makeToggle('Speed Hack', () => mv.speedEnabled, v => mv.speedEnabled = v));
    playerPanel.appendChild(makeSlider('Speed Multiplier', 1.0, 3.0, 0.1, () => mv.speedMultiplier, v => { mv.speedMultiplier = v; }));
    playerPanel.appendChild(makeKeybind('Speed Key', () => mv.speedKey, v => mv.speedKey = v || ''));

    playerPanel.appendChild(makeHeader('🌙 GRAVITY'));
    playerPanel.appendChild(makeToggle('Low Gravity', () => mv.gravityEnabled, v => mv.gravityEnabled = v));
    playerPanel.appendChild(makeSlider('Gravity Multiplier', 0.2, 1.0, 0.05, () => mv.gravityMultiplier, v => { mv.gravityMultiplier = v; }));

    playerPanel.appendChild(makeHeader('🎯 CROSSHAIR'));
    const ch = playerSet.crosshair;
    playerPanel.appendChild(makeToggle('Custom Crosshair', () => ch.enabled, v => {
        ch.enabled = v; updateCrosshairVisibility();
    }));
    playerPanel.appendChild(makeDropdown('Style', [
        { value: 'cross', label: 'Cross (+)' },
        { value: 'dot', label: 'Dot Only' },
        { value: 'circle', label: 'Circle' },
        { value: 'tshape', label: 'T-Shape' },
        { value: 'x', label: 'X Shape' },
        { value: 'crosshair_full', label: 'Full Cross' }
    ], () => ch.style, v => { ch.style = v; renderCrosshair(); }));
    playerPanel.appendChild(makeColorPicker('Color', () => ch.color, v => { ch.color = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Size', 0, 30, 1, () => ch.size, v => { ch.size = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Thickness', 1, 10, 1, () => ch.thickness, v => { ch.thickness = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Gap', 0, 20, 1, () => ch.gap, v => { ch.gap = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Alpha', 0, 1, 0.05, () => ch.alpha, v => { ch.alpha = v; renderCrosshair(); }));
    playerPanel.appendChild(makeToggle('Center Dot', () => ch.dot, v => { ch.dot = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Dot Size', 1, 10, 1, () => ch.dotSize, v => { ch.dotSize = v; renderCrosshair(); }));
    playerPanel.appendChild(makeToggle('Outline', () => ch.outline, v => { ch.outline = v; renderCrosshair(); }));
    playerPanel.appendChild(makeSlider('Outline Width', 1, 4, 1, () => ch.outlineWidth, v => { ch.outlineWidth = v; renderCrosshair(); }));
    playerPanel.appendChild(makeButton('Reset Crosshair', () => {
        Object.assign(ch, {
            enabled: false, style: 'cross', color: '#00ff00',
            size: 8, thickness: 2, gap: 4, dot: false, dotSize: 2,
            outline: false, outlineWidth: 1, alpha: 1.0
        });
        renderCrosshair(); updateCrosshairVisibility();
    }));

    // ============================================================
    //                       EFFECTS TAB
    // ============================================================
    const pe = settings.playerEffects;
    const lightning = pe.lightning;
    const effectsPanel = tabPanels.effects;
    effectsPanel.appendChild(makeHeader('KILL LIGHTNING'));
    effectsPanel.appendChild(makeToggle('Lightning Effect', () => lightning.enabled, v => lightning.enabled = v));
    effectsPanel.appendChild(makeSlider('Duration (ms)', 100, 2000, 50, () => lightning.duration, v => { lightning.duration = v; }));
    effectsPanel.appendChild(makeSlider('Thickness', 1, 10, 0.5, () => lightning.thickness, v => { lightning.thickness = v; }));
    effectsPanel.appendChild(makeSlider('Branches', 1, 5, 1, () => lightning.branches, v => { lightning.branches = v; }));
    effectsPanel.appendChild(makeColorPicker('Glow Color', () => lightning.color1, v => lightning.color1 = v));
    effectsPanel.appendChild(makeColorPicker('Core Color', () => lightning.color2, v => lightning.color2 = v));

    // ============================================================
    //                       SKINS TAB
    // ============================================================
    const skinsPanel = tabPanels.skins;
    skinsPanel.appendChild(makeHeader('🎨 SKIN GIVER'));
    const searchWrap = document.createElement('div');
    searchWrap.className = 'pp-row';
    searchWrap.style.cssText = 'flex-direction:column;align-items:stretch;gap:6px;';
    const searchLbl = document.createElement('span');
    searchLbl.textContent = 'Search skins:';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'AK-47 | The Empress...';
    searchInput.id = 'pp-skin-search';
    searchWrap.appendChild(searchLbl);
    searchWrap.appendChild(searchInput);
    skinsPanel.appendChild(searchWrap);

    const resultsContainer = document.createElement('div');
    resultsContainer.id = 'pp-skin-results';
    resultsContainer.innerHTML = '<div class="pp-note" style="grid-column:1/-1;">Type 2+ letters to search...</div>';
    skinsPanel.appendChild(resultsContainer);

    let searchTimeout = null;
    searchInput.oninput = (e) => {
        clearTimeout(searchTimeout);
        const q = e.target.value;
        searchTimeout = setTimeout(() => searchSkins(q), 300);
    };

    // ============================================================
    //                       TOOLS TAB
    // ============================================================
    const toolsPanel = tabPanels.tools;
    toolsPanel.appendChild(makeHeader('💰 COIN TOOLS'));

    const coinWrap = document.createElement('div');
    coinWrap.className = 'pp-row';
    coinWrap.style.cssText = 'flex-direction:column;align-items:stretch;';
    const coinLbl = document.createElement('span');
    coinLbl.textContent = 'Coin Amount';
    coinLbl.style.marginBottom = '6px';
    const coinInput = document.createElement('input');
    coinInput.type = 'number';
    coinInput.value = '999999';
    coinInput.style.cssText = `
        width: 100%; padding: 8px 10px;
        background: rgba(255,215,0,.1); color: #ffd700;
        border: 1px solid rgba(255,215,0,.3); border-radius: 6px;
        font-size: 14px; font-weight: 700;
        box-sizing: border-box;
    `;
    coinWrap.appendChild(coinLbl);
    coinWrap.appendChild(coinInput);
    toolsPanel.appendChild(coinWrap);

    const giveCoinsBtn = document.createElement('button');
    giveCoinsBtn.className = 'act';
    giveCoinsBtn.textContent = '💰 GIVE COINS';
    giveCoinsBtn.style.cssText = `
        display: block; width: 100%; padding: 12px;
        margin-top: 10px;
        background: rgba(255,215,0,.2); color: #ffd700;
        border: 1px solid #ffd700; border-radius: 8px;
        font-weight: 800; font-size: 15px; cursor: pointer;
    `;
    giveCoinsBtn.onclick = () => {
        try {
            const amount = parseInt(coinInput.value, 10) || 0;
            const current = JSON.parse(localStorage.getItem('clutcher_inv_v1') || '{}');
            current.coins = amount;
            localStorage.setItem('clutcher_inv_v1', JSON.stringify(current));
            giveCoinsBtn.textContent = `✅ Set to ${amount.toLocaleString()}! Reloading...`;
            setTimeout(() => location.reload(), 800);
        } catch (e) {
            giveCoinsBtn.textContent = '❌ Error: ' + e.message;
        }
    };
    toolsPanel.appendChild(giveCoinsBtn);

    // ============================================================
    //           ASPECT / FOV / SPREAD
    // ============================================================
    let originalAspectMode = null;
    function applyAspect() {
        const game = window.game;
        if (!game) return;
        if (originalAspectMode === null && game.aspectMode !== undefined) originalAspectMode = game.aspectMode;
        if (game.aspectMode !== visual.aspectRatio) {
            game.aspectMode = visual.aspectRatio;
            try {
                if (typeof game._applyAspect === 'function') game._applyAspect();
                if (typeof game._applyAspectMode === 'function') game._applyAspectMode();
                if (typeof game._resize === 'function') game._resize();
            } catch (e) {}
            window.dispatchEvent(new Event('resize'));
        }
    }
    function restoreAspect() {
        const game = window.game;
        if (!game || originalAspectMode === null) return;
        if (game.aspectMode !== originalAspectMode) {
            game.aspectMode = originalAspectMode;
            try {
                if (typeof game._applyAspect === 'function') game._applyAspect();
                if (typeof game._applyAspectMode === 'function') game._applyAspectMode();
                if (typeof game._resize === 'function') game._resize();
            } catch (e) {}
            window.dispatchEvent(new Event('resize'));
        }
    }

    let fovHookInstalled = false;
    let fovOriginalUpdateProjection = null;
    let fovOriginalBaseFov = undefined;
    function installFovHook() {
        if (fovHookInstalled) return;
        const game = window.game;
        if (!game || !game.camera) return;
        const cam = game.camera;
        if (!fovOriginalUpdateProjection) fovOriginalUpdateProjection = cam.updateProjectionMatrix.bind(cam);
        if (fovOriginalBaseFov === undefined && typeof game.baseFov === 'number') fovOriginalBaseFov = game.baseFov;
        cam.updateProjectionMatrix = function() {
            if (visual.fovChanger) cam.fov = visual.fovValue;
            return fovOriginalUpdateProjection();
        };
        fovHookInstalled = true;
    }
    function restoreFov() {
        const game = window.game;
        if (!game || !game.camera) return;
        const cam = game.camera;
        if (fovOriginalBaseFov !== undefined) {
            if (typeof game.baseFov === 'number') game.baseFov = fovOriginalBaseFov;
            if (!game.scoped) {
                cam.fov = fovOriginalBaseFov;
                cam.updateProjectionMatrix();
            }
        }
    }

    function runVisuals() {
        const game = window.game;
        if (!game || !game.weapons) return;
        const w = game.weapons;
        if (visual.noRecoil) {
            if (w.punch) {
                w.punch.aimPitch = 0; w.punch.aimYaw = 0;
                w.punch.velPitch = 0; w.punch.velYaw = 0;
                w.punch.viewPitch = 0; w.punch.viewYaw = 0;
            }
            w.punchP = 0; w.punchY = 0;
            w.shkP = 0; w.shkY = 0; w.shkPV = 0; w.shkRV = 0;
        }
        if (visual.noSpread) {
            if (w.acc) { w.acc.penalty = 0; w.acc.lastShot = -1e9; }
            w.inaccFire = 0;
        }
        const cam = game.camera;
        if (!cam) return;
        installFovHook();
        if (visual.fovChanger) {
            if (Math.abs(cam.fov - visual.fovValue) > 0.001) {
                cam.fov = visual.fovValue;
                cam.updateProjectionMatrix();
            }
            if (typeof game.baseFov === 'number') game.baseFov = visual.fovValue;
        } else if (fovOriginalBaseFov !== undefined) {
            if (typeof game.baseFov === 'number' && game.baseFov !== fovOriginalBaseFov) {
                game.baseFov = fovOriginalBaseFov;
            }
        }
    }

    let aggressiveNoSpreadInstalled = false;
    let noSpreadTimer = null;
    function installAggressiveNoSpread() {
        if (aggressiveNoSpreadInstalled) return;
        const g = window.game;
        if (!g || !g.weapons) return;
        if (!g._origPlayerShoot && typeof g.playerShoot === 'function') g._origPlayerShoot = g.playerShoot.bind(g);
        if (g._origPlayerShoot) g.playerShoot = function(def) { return g._origPlayerShoot(def, 0, 0); };
        const w = g.weapons;
        if (!noSpreadTimer) {
            noSpreadTimer = setInterval(() => {
                if (!visual.noSpreadAggressive) return;
                if (!w.acc) return;
                w.acc.penalty = 0; w.acc.lastShot = -1e9; w.inaccFire = 0;
                if (w.punch) {
                    w.punch.aimPitch = 0; w.punch.aimYaw = 0;
                    w.punch.velPitch = 0; w.punch.velYaw = 0;
                    w.punch.viewPitch = 0; w.punch.viewYaw = 0;
                    w.punch.index = 0;
                }
            }, 16);
        }
        aggressiveNoSpreadInstalled = true;
    }
    function uninstallAggressiveNoSpread() {
        const g = window.game;
        if (g && g._origPlayerShoot && g.playerShoot) {
            g.playerShoot = g._origPlayerShoot;
            g._origPlayerShoot = null;
        }
        if (noSpreadTimer) { clearInterval(noSpreadTimer); noSpreadTimer = null; }
        aggressiveNoSpreadInstalled = false;
    }

    function runPlayer() {
        const game = window.game;
        if (!game || !game.weapons) return;
        const w = game.weapons;
        const st = w.state ? w.state() : null;
        const def = w.def ? w.def() : null;
        if (!st || !def) return;
        if (playerSet.infAmmo) {
            if (def.mag && def.mag !== Infinity && st.ammo < def.mag) st.ammo = def.mag;
            if (def.reserve && st.reserve < def.reserve) st.reserve = def.reserve;
        }
        if (playerSet.noReload) {
            w.reloading = false;
            if (def.mag && def.mag !== Infinity) st.ammo = def.mag;
        }
    }

    // ============================================================
    //                  KILL LIGHTNING / CROSSHAIR / ESP
    // ============================================================
    const killLightnings = [];
    let killHookInstalled = false;

    function generateBoltPath(sx, sy, ex, ey, seg, offset) {
        const pts = [];
        for (let i = 0; i <= seg; i++) {
            const t = i / seg;
            let px = sx + (ex - sx) * t;
            let py = sy + (ey - sy) * t;
            if (i > 0 && i < seg) {
                px += (Math.random() - 0.5) * offset;
                py += (Math.random() - 0.5) * offset;
            }
            pts.push({ x: px, y: py });
        }
        return pts;
    }
    function drawOneBolt(ctx, sx, sy, age) {
        const life = 1 - (age / lightning.duration);
        const startX = sx + (Math.random() - 0.5) * 80;
        const pts = generateBoltPath(startX, -30, sx, sy, 14, 55 * life);
        ctx.save();
        ctx.globalAlpha = life;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.shadowColor = lightning.color1; ctx.shadowBlur = 35;
        ctx.strokeStyle = lightning.color1; ctx.lineWidth = lightning.thickness * life;
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
    }
    function updateAndDrawLightning(ctx, cam) {
        if (killLightnings.length === 0) return;
        const now = performance.now();
        for (let i = killLightnings.length - 1; i >= 0; i--) {
            const bolt = killLightnings[i];
            const age = now - bolt.startTime;
            if (age > lightning.duration) { killLightnings.splice(i, 1); continue; }
            const bot = bolt.bot;
            if (!bot || !bot.cs2Agent || !bot.cs2Agent.root) { killLightnings.splice(i, 1); continue; }
            const root = bot.cs2Agent.root;
            const sp = w2s({
                x: root.position.x,
                y: root.position.y + (bot.height || 1.8),
                z: root.position.z
            }, cam);
            if (!sp) continue;
            drawOneBolt(ctx, sp.x, sp.y, age);
        }
    }
    function installKillHook() {
        if (killHookInstalled) return;
        const game = window.game;
        if (!game || !game.killEntity) return;
        const original = game.killEntity.bind(game);
        game.killEntity = function(...args) {
            const result = original(...args);
            const victim = args[0], killer = args[1];
            if (victim && victim.isPlayer === false && killer && killer.isPlayer === true) {
                if (lightning.enabled) killLightnings.push({ bot: victim, startTime: performance.now() });
            }
            return result;
        };
        killHookInstalled = true;
    }

    const chCanvas = document.createElement('canvas');
    chCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9998;';
    document.body.appendChild(chCanvas);
    const chCtx = chCanvas.getContext('2d');
    function resizeChCanvas() { chCanvas.width = innerWidth; chCanvas.height = innerHeight; }
    addEventListener('resize', resizeChCanvas); resizeChCanvas();

    let hiddenEls = [];
    function updateCrosshairVisibility() {
        const list = document.querySelectorAll('#crosshair, .crosshair, [class*="crosshair"], [id*="crosshair"]');
        for (const el of hiddenEls) if (el && el._chv !== undefined) el.style.visibility = el._chv;
        hiddenEls = [];
        if (ch.enabled) {
            for (const el of list) {
                if (el === chCanvas) continue;
                el._chv = el.style.visibility;
                el.style.visibility = 'hidden';
                hiddenEls.push(el);
            }
        }
    }

    function renderCrosshair() {
        chCtx.clearRect(0, 0, chCanvas.width, chCanvas.height);
        if (!ch.enabled) return;
        const cx = chCanvas.width / 2, cy = chCanvas.height / 2;
        const size = ch.size, thick = ch.thickness, gap = ch.gap, color = ch.color;
        chCtx.save();
        chCtx.globalAlpha = ch.alpha;
        const outlineColor = 'rgba(0,0,0,' + (ch.alpha * 0.85) + ')';
        function drawLine(x1, y1, x2, y2) {
            if (ch.outline) {
                chCtx.strokeStyle = outlineColor;
                chCtx.lineWidth = thick + ch.outlineWidth * 2;
                chCtx.beginPath(); chCtx.moveTo(x1, y1); chCtx.lineTo(x2, y2); chCtx.stroke();
            }
            chCtx.strokeStyle = color; chCtx.lineWidth = thick;
            chCtx.beginPath(); chCtx.moveTo(x1, y1); chCtx.lineTo(x2, y2); chCtx.stroke();
        }
        function drawDot(x, y, r) {
            if (ch.outline) {
                chCtx.fillStyle = outlineColor;
                chCtx.beginPath(); chCtx.arc(x, y, r + ch.outlineWidth, 0, Math.PI * 2); chCtx.fill();
            }
            chCtx.fillStyle = color;
            chCtx.beginPath(); chCtx.arc(x, y, r, 0, Math.PI * 2); chCtx.fill();
        }
        function drawCircle(radius) {
            if (ch.outline) {
                chCtx.strokeStyle = outlineColor;
                chCtx.lineWidth = thick + ch.outlineWidth * 2;
                chCtx.beginPath(); chCtx.arc(cx, cy, radius, 0, Math.PI * 2); chCtx.stroke();
            }
            chCtx.strokeStyle = color; chCtx.lineWidth = thick;
            chCtx.beginPath(); chCtx.arc(cx, cy, radius, 0, Math.PI * 2); chCtx.stroke();
        }
        switch (ch.style) {
            case 'cross':
                drawLine(cx - gap - size, cy, cx - gap, cy);
                drawLine(cx + gap, cy, cx + gap + size, cy);
                drawLine(cx, cy - gap - size, cx, cy - gap);
                drawLine(cx, cy + gap, cx, cy + gap + size);
                if (ch.dot) drawDot(cx, cy, ch.dotSize / 2);
                break;
            case 'dot': drawDot(cx, cy, ch.dotSize / 2 + 1); break;
            case 'circle':
                drawCircle(gap + size);
                if (ch.dot) drawDot(cx, cy, ch.dotSize / 2);
                break;
            case 'tshape':
                drawLine(cx - gap - size, cy, cx - gap, cy);
                drawLine(cx + gap, cy, cx + gap + size, cy);
                drawLine(cx, cy + gap, cx, cy + gap + size);
                if (ch.dot) drawDot(cx, cy, ch.dotSize / 2);
                break;
            case 'x': {
                const g = gap / Math.sqrt(2), s = size / Math.sqrt(2);
                drawLine(cx - g - s, cy - g - s, cx - g, cy - g);
                drawLine(cx + g, cy + g, cx + g + s, cy + g + s);
                drawLine(cx - g - s, cy + g + s, cx - g, cy + g);
                drawLine(cx + g, cy - g, cx + g + s, cy - g - s);
                if (ch.dot) drawDot(cx, cy, ch.dotSize / 2);
                break;
            }
            case 'crosshair_full':
                drawLine(cx - size, cy, cx + size, cy);
                drawLine(cx, cy - size, cx, cy + size);
                if (ch.dot) drawDot(cx, cy, ch.dotSize / 2);
                break;
        }
        chCtx.restore();
    }
    renderCrosshair(); updateCrosshairVisibility();
    setInterval(() => { if (ch.enabled) updateCrosshairVisibility(); }, 1000);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
    addEventListener('resize', resize); resize();

    function w2s(p, cam) {
        if (!cam || !cam.matrixWorldInverse || !cam.projectionMatrix) return null;
        const v = cam.matrixWorldInverse.elements;
        const pr = cam.projectionMatrix.elements;
        const x = p.x, y = p.y, z = p.z;
        const vx = v[0]*x + v[4]*y + v[8]*z + v[12];
        const vy = v[1]*x + v[5]*y + v[9]*z + v[13];
        const vz = v[2]*x + v[6]*y + v[10]*z + v[14];
        const vw = v[3]*x + v[7]*y + v[11]*z + v[15];
        const px = pr[0]*vx + pr[4]*vy + pr[8]*vz + pr[12]*vw;
        const py = pr[1]*vx + pr[5]*vy + pr[9]*vz + pr[13]*vw;
        const pw = pr[3]*vx + pr[7]*vy + pr[11]*vz + pr[15]*vw;
        if (pw <= 0) return null;
        return {
            x: (px/pw * 0.5 + 0.5) * innerWidth,
            y: (-py/pw * 0.5 + 0.5) * innerHeight
        };
    }

    const SKELETON_BONES = [
        ['head_0', 'neck_0'], ['neck_0', 'spine_2'], ['spine_2', 'spine_0'],
        ['spine_0', 'pelvis'],
        ['spine_2', 'arm_upper_L'], ['arm_upper_L', 'arm_lower_L'], ['arm_lower_L', 'hand_L'],
        ['spine_2', 'arm_upper_R'], ['arm_upper_R', 'arm_lower_R'], ['arm_lower_R', 'hand_R'],
        ['pelvis', 'leg_upper_L'], ['leg_upper_L', 'leg_lower_L'], ['leg_lower_L', 'ankle_L'],
        ['pelvis', 'leg_upper_R'], ['leg_upper_R', 'leg_lower_R'], ['leg_lower_R', 'ankle_R']
    ];

    function drawSkeleton(ctx, bot, cam, color) {
        const agent = bot.cs2Agent;
        if (!agent || !agent.bones) return;
        const bones = agent.bones;
        const thickness = SKEL.thickness;
        const outlineW = SKEL.outline ? thickness + 2 : 0;
        for (const [a, b] of SKELETON_BONES) {
            const bA = bones[a], bB = bones[b];
            if (!bA || !bB || !bA.matrixWorld || !bB.matrixWorld) continue;
            const mA = bA.matrixWorld.elements;
            const mB = bB.matrixWorld.elements;
            const sA = w2s({ x: mA[12], y: mA[13], z: mA[14] }, cam);
            const sB = w2s({ x: mB[12], y: mB[13], z: mB[14] }, cam);
            if (!sA || !sB) continue;
            if (SKEL.outline) {
                ctx.strokeStyle = SKEL.outlineColor; ctx.lineWidth = outlineW;
                ctx.beginPath(); ctx.moveTo(sA.x, sA.y); ctx.lineTo(sB.x, sB.y); ctx.stroke();
            }
            ctx.strokeStyle = color; ctx.lineWidth = thickness;
            ctx.beginPath(); ctx.moveTo(sA.x, sA.y); ctx.lineTo(sB.x, sB.y); ctx.stroke();
        }
    }

    const glowSaved = new Map();
    function collectBotMeshes() {
        const game = window.game;
        const out = [];
        if (!game || !game.botMgr) return out;
        for (const bot of game.botMgr.bots) {
            if (!bot.alive) continue;
            const agent = bot.cs2Agent;
            if (!agent || !agent.root) continue;
            agent.root.traverse(o => { if (o.isMesh || o.isSkinnedMesh) out.push({ mesh: o, bot }); });
        }
        return out;
    }
    function applyGlow() {
        const game = window.game;
        const player = game && game.player;
        if (!player) return;
        for (const { mesh, bot } of collectBotMeshes()) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of mats) {
                if (!mat || !mat.emissive) continue;
                if (!glowSaved.has(mat.uuid)) {
                    glowSaved.set(mat.uuid, {
                        mat,
                        oldEmissive: mat.emissive.clone(),
                        oldEmissiveIntensity: mat.emissiveIntensity,
                        oldEmissiveMap: mat.emissiveMap,
                        oldDepthTest: mat.depthTest
                    });
                }
                const isEnemy = bot.team !== player.team;
                if (isEnemy) { mat.emissive.setRGB(1, 0.05, 0.05); mat.emissiveIntensity = 2.5; }
                else { mat.emissive.setRGB(0.05, 1, 0.05); mat.emissiveIntensity = 1.5; }
                mat.emissiveMap = null; mat.depthTest = false; mat.needsUpdate = true;
            }
        }
    }
    function restoreGlow() {
        for (const [, s] of glowSaved) {
            if (s.mat.emissive) s.mat.emissive.copy(s.oldEmissive);
            s.mat.emissiveIntensity = s.oldEmissiveIntensity;
            s.mat.emissiveMap = s.oldEmissiveMap;
            s.mat.depthTest = s.oldDepthTest;
            s.mat.needsUpdate = true;
        }
        glowSaved.clear();
    }

    function getAimKeyPressed() {
        if (aim.alwaysOn) return true;
        const input = window.game && window.game.input;
        if (!input) return false;
        switch (aim.key) {
            case 'Mouse1': return !!input.mouse1;
            case 'Mouse2': return !!input.mouse2;
            case 'ShiftLeft': return input.keys && input.keys.has('ShiftLeft');
            case 'ControlLeft': return input.keys && input.keys.has('ControlLeft');
            case 'AltLeft': return input.keys && input.keys.has('AltLeft');
            case null:
            case '': return true;
            default: return input.keys && input.keys.has(aim.key);
        }
    }
    function boneName(bone) {
        switch (bone) {
            case 'head': return 'head_0';
            case 'neck': return 'neck_0';
            case 'chest': return 'spine_2';
            case 'stomach': return 'spine_0';
            case 'feet': return 'ankle_L';
            default: return 'head_0';
        }
    }
    const _tmp = { x: 0, y: 0, z: 0 };
    function getBoneWorld(bot, bone) {
        const agent = bot.cs2Agent;
        if (!agent || !agent.bones) return null;
        const b = agent.bones[boneName(bone)];
        if (!b || !b.matrixWorld) return null;
        const m = b.matrixWorld.elements;
        _tmp.x = m[12]; _tmp.y = m[13]; _tmp.z = m[14];
        return _tmp;
    }

    // ============================================================
    //   SMART AIMBOT  —  projectile algılama ile
    // ============================================================
    function runAimbot() {
        if (!aim.enabled) return;
        const game = window.game;
        if (!game || game.state !== 'playing') return;
        const player = game.player;
        if (!player || !player.alive) return;
        if (!getAimKeyPressed()) return;

        // Projectile silah mı?
        const isProjectile = isProjectileWeapon(game);

        // Hangi bone kullanılacak?
        let useBone = aim.targetBone;
        let useSmooth = aim.smooth;
        let useVisibleOnly = aim.visibleOnly;

        if (isProjectile && aim.projectileSnap) {
            // Grenade/molotov: tam hedefe kilitlen, smooth=1 (anında)
            useBone = aim.projectileBone;
            useSmooth = 1;
            useVisibleOnly = false;
        }

        const bots = game.botMgr ? game.botMgr.bots : [];
        const px = player.x, py = player.y + player.eyeH, pz = player.z;
        const cosP = Math.cos(player.pitch);
        const fwdX = -Math.sin(player.yaw) * cosP;
        const fwdY = Math.sin(player.pitch);
        const fwdZ = -Math.cos(player.yaw) * cosP;
        const cosFov = Math.cos(aim.fov * Math.PI / 180);
        let best = null, bestScore = -Infinity;

        for (const bot of bots) {
            if (!bot.alive) continue;
            if (aim.teamCheck && bot.team === player.team) continue;

            const bp = getBoneWorld(bot, useBone);
            let tx, ty, tz;
            if (bp) { tx = bp.x; ty = bp.y; tz = bp.z; }
            else {
                const h = bot.height || 1.8;
                const frac = useBone === 'head' ? 0.85
                           : useBone === 'neck' ? 0.78
                           : useBone === 'chest' ? 0.65
                           : useBone === 'stomach' ? 0.50
                           : useBone === 'feet' ? 0.05 : 0.85;
                tx = bot.x; ty = bot.y + h * frac; tz = bot.z;
            }

            const dx = tx - px, dy = ty - py, dz = tz - pz;
            const dist = Math.hypot(dx, dy, dz);
            if (dist < 0.1 || dist > aim.maxDist) continue;

            const nx = dx / dist, ny = dy / dist, nz = dz / dist;
            const dot = nx * fwdX + ny * fwdY + nz * fwdZ;
            if (dot < cosFov) continue;

            if (useVisibleOnly) {
                const phys = game.physics;
                if (phys && phys.lineClear) {
                    if (!phys.lineClear(px, py, pz, tx, ty, tz)) continue;
                }
            }

            const score = dot - dist * 0.002;
            if (score > bestScore) { bestScore = score; best = { x: tx, y: ty, z: tz }; }
        }

        if (!best) return;

        const dx = best.x - px, dy = best.y - py, dz = best.z - pz;
        const tYaw = Math.atan2(-dx, -dz);
        const tPitch = Math.atan2(dy, Math.hypot(dx, dz));

        function delta(a, b) {
            let d = (b - a) % (Math.PI * 2);
            if (d > Math.PI) d -= Math.PI * 2;
            if (d < -Math.PI) d += Math.PI * 2;
            return d;
        }

        const s = Math.max(1, useSmooth), step = 1 / s;
        player.yaw += delta(player.yaw, tYaw) * step;
        player.pitch += delta(player.pitch, tPitch) * step;
        const maxP = Math.PI / 2 - 0.01;
        if (player.pitch > maxP) player.pitch = maxP;
        if (player.pitch < -maxP) player.pitch = -maxP;
    }

    function drawESP(ctx, game) {
        const cam = game.camera;
        const player = game.player;
        const bots = game.botMgr ? game.botMgr.bots : [];
        if (!cam || !player || !bots.length) return;
        const cw = canvas.width, chh = canvas.height;
        const cx = cw / 2, cy = chh / 2;
        if (aim.enabled && aim.drawFov) {
            const fovRad = aim.fov * Math.PI / 180;
            const camFovRad = (cam.fov || 74) * Math.PI / 180;
            const radiusPx = Math.tan(fovRad) / Math.tan(camFovRad / 2) * cy;
            ctx.strokeStyle = 'rgba(255, 100, 100, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(cx, cy, Math.min(radiusPx, cy * 1.5), 0, Math.PI * 2); ctx.stroke();
        }
        for (const bot of bots) {
            if (!bot.alive) continue;
            const isEnemy = bot.team !== player.team;
            if (esp.skeleton) drawSkeleton(ctx, bot, cam, isEnemy ? SKEL.colorEnemy : SKEL.colorTeam);
            if (!esp.enabled) continue;
            if (isEnemy && !esp.showEnemy) continue;
            if (!isEnemy && !esp.showTeam) continue;
            const h = bot.height || 1.8;
            const headS = w2s({ x: bot.x, y: bot.y + h * 0.95, z: bot.z }, cam);
            const feetS = w2s({ x: bot.x, y: bot.y, z: bot.z }, cam);
            const color = isEnemy ? '#ff3030' : '#30ff30';
            if ((!headS || !feetS) && esp.offscreen) {
                const dx = bot.x - player.x, dz = bot.z - player.z;
                const dist = Math.hypot(dx, dz);
                if (dist < 0.1) continue;
                const angle = Math.atan2(dz, dx) - player.yaw;
                const r = Math.min(cw, chh) * 0.42;
                const ax = cx + Math.cos(angle) * r;
                const ay = cy + Math.sin(angle) * r;
                ctx.save(); ctx.translate(ax, ay); ctx.rotate(angle);
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(14, 0); ctx.lineTo(0, 6); ctx.closePath(); ctx.fill();
                ctx.restore();
                continue;
            }
            if (!headS || !feetS) continue;
            const boxH = Math.abs(headS.y - feetS.y);
            const boxW = boxH * 0.5;
            const topY = Math.min(headS.y, feetS.y);
            const bottomY = Math.max(headS.y, feetS.y);
            const leftX = headS.x - boxW / 2;
            const rightX = headS.x + boxW / 2;
            if (esp.snapline) {
                ctx.save();
                ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7;
                ctx.beginPath(); ctx.moveTo(cw / 2, chh); ctx.lineTo(headS.x, headS.y); ctx.stroke();
                ctx.restore();
            }
            if (esp.filled) {
                ctx.fillStyle = isEnemy ? 'rgba(255, 48, 48, 0.08)' : 'rgba(48, 255, 48, 0.08)';
                ctx.fillRect(leftX, topY, boxW, boxH);
            }
            if (esp.corners) {
                const cLen = Math.min(14, boxW * 0.35, boxH * 0.15);
                ctx.strokeStyle = color; ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(leftX, topY + cLen); ctx.lineTo(leftX, topY); ctx.lineTo(leftX + cLen, topY);
                ctx.moveTo(rightX - cLen, topY); ctx.lineTo(rightX, topY); ctx.lineTo(rightX, topY + cLen);
                ctx.moveTo(leftX, bottomY - cLen); ctx.lineTo(leftX, bottomY); ctx.lineTo(leftX + cLen, bottomY);
                ctx.moveTo(rightX - cLen, bottomY); ctx.lineTo(rightX, bottomY); ctx.lineTo(rightX, bottomY - cLen);
                ctx.stroke();
            } else {
                ctx.strokeStyle = color; ctx.lineWidth = 2.5;
                ctx.strokeRect(leftX, topY, boxW, boxH);
            }
            let label = '';
            if (esp.showName) label = (bot.name || 'Bot');
            const extra = [];
            if (esp.showDistance) {
                const d = Math.hypot(bot.x - player.x, bot.y - player.y, bot.z - player.z);
                extra.push(d.toFixed(1) + 'm');
            }
            if (extra.length) label += (label ? '  ' : '') + extra.join('  ');
            if (label) {
                ctx.font = 'bold 16px Arial'; ctx.textAlign = 'center';
                const tw = ctx.measureText(label).width;
                const boxTop = topY - 22;
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(headS.x - tw / 2 - 6, boxTop - 17, tw + 12, 24);
                ctx.fillStyle = color;
                ctx.fillText(label, headS.x, boxTop);
            }
            if (esp.showHealth) {
                const hp = Math.max(0, Math.min(100, bot.health || 0));
                const barY = bottomY + 4, barH = 6;
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(leftX - 1, barY - 1, boxW + 2, barH + 2);
                ctx.fillStyle = hp > 50 ? '#00ff00' : hp > 20 ? '#ffff00' : '#ff0000';
                ctx.fillRect(leftX, barY, boxW * (hp / 100), barH);
            }
        }
    }

    // ============================================================
    // STATUS UPDATERS
    // ============================================================
    let vmFovStatusTick = 0;
    function updateVmFovStatus() {
        vmFovStatusTick++;
        if (vmFovStatusTick % 30 !== 0) return;
        const statusEl = document.getElementById('pp-vmfov-status');
        if (!statusEl) return;
        try {
            const game = window.game;
            const vmCam = game && game.viewmodel && game.viewmodel.camera;
            if (!vmCam) {
                statusEl.textContent = '⚠ ViewModel camera not found';
                statusEl.style.color = '#ffb340';
                return;
            }
            if (vmFovOriginal !== null) {
                statusEl.textContent = `✓ VM FOV: ${vmCam.fov.toFixed(1)}° (orig: ${vmFovOriginal.toFixed(1)}°)`;
                statusEl.style.color = '#22d3ee';
            } else {
                statusEl.textContent = 'ℹ️ Waiting...';
                statusEl.style.color = '#9a8fc0';
            }
        } catch {}
    }

    let tpStatusTick = 0;
    function updateTpStatus() {
        tpStatusTick++;
        if (tpStatusTick % 30 !== 0) return;
        const statusEl = document.getElementById('pp-tp-status');
        if (!statusEl) return;
        if (!visual.thirdPerson) {
            statusEl.textContent = '⏸ Disabled';
            statusEl.style.color = '#9a8fc0';
            return;
        }
        const game = window.game;
        if (!game || !game.camera || !game.player) {
            statusEl.textContent = '⚠ Waiting for game...';
            statusEl.style.color = '#ffb340';
            return;
        }
        const cam = game.camera;
        const p = game.player;
        const dist = Math.hypot(cam.position.x - p.x, cam.position.z - p.z);

        let modelStatus = '';
        if (visual.thirdPersonShowModel) {
            if (tpLoading) modelStatus = ' · Loading model...';
            else if (tpAgent) modelStatus = ' · Model ✓';
            else modelStatus = ' · No model';
        }

        statusEl.textContent = `✓ Active — camera ${dist.toFixed(1)}m behind${modelStatus}`;
        statusEl.style.color = '#22c55e';
    }

    let projStatusTick = 0;
    function updateProjStatus() {
        projStatusTick++;
        if (projStatusTick % 15 !== 0) return;
        const statusEl = document.getElementById('pp-proj-status');
        if (!statusEl) return;
        const game = window.game;
        if (!game) {
            statusEl.textContent = 'ℹ️ Waiting for game...';
            statusEl.style.color = '#9a8fc0';
            return;
        }
        const isProj = isProjectileWeapon(game);
        if (!aim.projectileSnap) {
            statusEl.textContent = '⏸ Projectile snap kapalı';
            statusEl.style.color = '#9a8fc0';
        } else if (isProj) {
            statusEl.textContent = '💣 PROJECTILE AKTİF — tam hedefe kilitleniyor!';
            statusEl.style.color = '#ff8033';
        } else {
            statusEl.textContent = '🔫 Silah aktif — projectile bekleniyor';
            statusEl.style.color = '#22d3ee';
        }
    }

    // ============ MAIN LOOP ============
    let lastGlow = false;
    let initAttempts = 0;

    function loop() {
        requestAnimationFrame(loop);
        const game = window.game;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (game && !killHookInstalled) installKillHook();
        if (game) installThirdPersonHooks(game);
        renderCrosshair();

        applyViewModelFov();
        updateVmFovStatus();
        updateTpStatus();
        updateProjStatus();

        if (!game || game.state !== 'playing') {
            if (lastGlow) { restoreGlow(); lastGlow = false; }
            killLightnings.length = 0;
            if (aggressiveNoSpreadInstalled) uninstallAggressiveNoSpread();
            restoreViewModelVisibility();
            return;
        }

        if (visual.thirdPerson && visual.thirdPersonShowModel) {
            if (!tpAgent) {
                ensureThirdPersonModel(game);
            } else {
                updateThirdPersonModel(game);
            }
        } else if (tpAgent && (!visual.thirdPerson || !visual.thirdPersonShowModel)) {
            cleanupThirdPersonModel();
        }

        if (visual.aspectEnabled) applyAspect();
        if (visual.weaponOpacity < 1.0 || visual.handsOpacity < 1.0) applyTransparency();
        else if (transparencyActive) restoreTransparency();

        if (esp.glow) { applyGlow(); lastGlow = true; }
        else if (lastGlow) { restoreGlow(); lastGlow = false; }

        runAimbot();
        runVisuals();
        runPlayer();
        runMovement();

        if (visual.noSpreadAggressive && !aggressiveNoSpreadInstalled) installAggressiveNoSpread();
        else if (!visual.noSpreadAggressive && aggressiveNoSpreadInstalled) uninstallAggressiveNoSpread();

        if (game.camera) updateAndDrawLightning(ctx, game.camera);
        drawESP(ctx, game);
    }

    // ============ INIT ============
    const hookInterval = setInterval(() => {
        initAttempts++;
        if (window.game && window.game.killEntity) {
            installKillHook();
            if (window.game.camera) installFovHook();
            installThirdPersonHooks(window.game);
            if (window.game.viewmodel && window.game.viewmodel.camera) {
                try { vmFovOriginal = window.game.viewmodel.camera.fov; } catch {}
            }
            clearInterval(hookInterval);
        }
        if (initAttempts > 60) clearInterval(hookInterval);
    }, 1000);

    requestAnimationFrame(loop);

    setModeOpen();

    console.log('[WATCHING v51.3] Wallbang kaldırıldı, Projectile Aim eklendi!');
})();