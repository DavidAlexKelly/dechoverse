import React, { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { loadHat } from "@/foundry/wearables";

/**
 * Where the top of a head is, in avatar-local metres.
 *
 * The body is a capsule of radius 0.34 and length 1.1 centred at y = 0.95, so
 * its crown is at 1.84. Sitting the hat a little below that beds it into the
 * head instead of balancing it on the single highest point.
 */
const HEAD_TOP_Y = 1.78;

/**
 * Paints a cloned hat, and hands back the materials it now owns.
 *
 * The trap here is that Object3D.clone shares materials with the original, so
 * setting a colour on a clone would repaint the hat on every other head in the
 * room — and the picker's preview with it. Each tinted copy therefore gets its
 * own clone of each material, which is also why they have to be disposed when
 * the wearer takes the hat off.
 *
 * The colour multiplies whatever the model already has, so a textured hat is
 * tinted rather than flattened to a single flat colour.
 */
function tint(model: THREE.Object3D, color: string): THREE.Material[] {
  const owned: THREE.Material[] = [];

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) {
      return;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const painted = materials.map((material) => {
      const copy = material.clone();
      // Only materials with a colour to set; a depth or shadow material has
      // none, and asking for one would be a runtime error.
      if ("color" in copy) {
        (copy as THREE.MeshStandardMaterial).color.set(color);
      }
      owned.push(copy);
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? painted : painted[0];
  });

  return owned;
}

/**
 * A hat on an avatar's head.
 *
 * Nothing is drawn until the model arrives, and a hat that will not load
 * simply does not appear — the same treatment props get. Hats are not
 * shootable: they are worn, not placed, so the eraser has no business with
 * them and a shot at someone's head should hit the block behind them.
 */
export function Hat({
  path,
  color,
}: {
  path: string;
  /** Tint, or null to wear the hat in the colours it was modelled. */
  color: string | null;
}): React.ReactElement | null {
  const [scene, setScene] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let cancelled = false;
    setScene(null);
    void loadHat(path)
      .then((loaded) => {
        if (!cancelled) {
          setScene(loaded);
        }
      })
      .catch(() => {
        // A hat that will not load leaves the head bare.
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /*
   * Cloned per wearer: an Object3D can only sit at one place in the graph, so
   * the shared original would jump between everyone wearing the same hat.
   * Untinted clones share geometry and materials, so the cost is a node tree.
   */
  const { copy, materials } = useMemo(() => {
    if (scene == null) {
      return { copy: null, materials: [] as THREE.Material[] };
    }
    const clone = scene.clone(true);
    return { copy: clone, materials: color == null ? [] : tint(clone, color) };
  }, [scene, color]);

  // Materials cloned for a tint are ours to release; the shared originals are
  // not, and are left alone.
  useEffect(() => {
    return () => {
      for (const material of materials) {
        material.dispose();
      }
    };
  }, [materials]);

  if (copy == null) {
    return null;
  }

  return (
    <group position={[0, HEAD_TOP_Y, 0]}>
      <primitive object={copy} />
    </group>
  );
}
