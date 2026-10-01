import {
  Actor,
  Ammo,
  Game,
  ObjectReference,
  Spell,
  Ui,
  setInventory,
} from 'skyrimPlatform';

import { Entry, Inventory, applyInventory, getInventory } from './inventory';
import { gmTrace } from '../debugTrace';

export const enum SpellType {
  Left,
  Right,
  Voice,
  Instant,
}

export const getEquipedSpell = (
  refr: ObjectReference,
  spellType: SpellType,
): number => {
  const actor = Actor.from(refr);

  if (!actor) {
    return 0;
  }

  switch (spellType) {
    case SpellType.Left: {
      const spell = actor.getEquippedSpell(SpellType.Left);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Right: {
      const spell = actor.getEquippedSpell(SpellType.Right);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Voice: {
      const spell = actor.getEquippedSpell(SpellType.Voice);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Instant: {
      const spell = actor.getEquippedSpell(SpellType.Instant);
      return spell ? spell.getFormID() : 0;
    }
    default: {
      return 0;
    }
  }
};

export interface Equipment {
  inv: Inventory;
  leftSpell?: number;
  rightSpell?: number;
  voiceSpell?: number;
  instantSpell?: number;
  numChanges: number;
}

const filterWorn = (inv: Inventory): Inventory => {
  return { entries: inv.entries.filter((x) => x.worn || x.wornLeft) };
};

const removeUnnecessaryExtra = (inv: Inventory, ignoreAmmo: boolean): Inventory => {
  return {
    entries: inv.entries.map((x) => {
      const r: Entry = JSON.parse(JSON.stringify(x));
      r.chargePercent = r.maxCharge;
      if (ignoreAmmo) {
        r.count = Ammo.from(Game.getFormEx(x.baseId)) ? r.count : 1;
      } else {
        r.count = Ammo.from(Game.getFormEx(x.baseId)) ? 1000 : 1;
      }
      // ia-forge: the name is kept, the inventory apply now tells named copies apart (docs/91). The game names every
      // worn entry with the object's own name ("Common Clothes 07"): that one is no name, or the apply recreated a
      // named copy that the server's unnamed inventory then took off (worn clothes lost at each login, 1er/10).
      const own = Game.getFormEx(x.baseId)?.getName();
      if (r.name && own && r.name.toLowerCase() === own.toLowerCase()) delete r.name;
      return r;
    }),
  };
};

export const getEquipment = (ac: Actor, numChanges: number): Equipment => {
  return {
    inv: getInventory(ac),
    leftSpell: getEquipedSpell(ac, SpellType.Left),
    rightSpell: getEquipedSpell(ac, SpellType.Right),
    voiceSpell: getEquipedSpell(ac, SpellType.Voice),
    instantSpell: getEquipedSpell(ac, SpellType.Instant),
    numChanges,
  };
};

export const syncSpellEquipment = (
  ac: Actor,
  spellBaseId: number | undefined,
  spellType: SpellType,
) => {
  if (spellBaseId !== undefined && spellBaseId > 0) {
    ac.equipSpell(Spell.from(Game.getFormEx(spellBaseId)), spellType);
  } else {
    const equipedSpell = ac.getEquippedSpell(spellType);

    if (equipedSpell) {
      ac.unequipSpell(equipedSpell, spellType);
    }
  }
};

export const applyEquipment = (ac: Actor, eq: Equipment): boolean => {
  ac.removeAllItems(null, false, true);

  ac.unequipAll();

  ac.removeAllItems(null, false, true);

  const isPlayer = ac.getFormID() === 0x14;
  const newInventory = removeUnnecessaryExtra(filterWorn(eq.inv), isPlayer);
  if (isPlayer)
    gmTrace('login', 'equipment apply', {
      received: eq.inv.entries.filter((x) => x.worn || x.wornLeft).map((x) => ({ id: x.baseId.toString(16), name: x.name })),
      applied: newInventory.entries.map((x) => ({ id: x.baseId.toString(16), name: x.name, worn: x.worn })),
    });

  // ia-forge: setInventory recreates a bare copy (no name, enchantment or tempering), which the inventory apply then
  // takes off as a stranger: copies with details go through addItemEx afterwards (docs/91). Plain ones stay with
  // setInventory: addItemEx put weapons back on but never clothes (worn outfit lost at each login, 1er/10).
  if (isPlayer) {
    const plain = (e: Entry) => !e.name && !e.enchantmentId && !e.poisonId && !e.soul && !((e.health ?? 1) > 1);
    setInventory(ac.getFormID(), { entries: newInventory.entries.filter(plain) });
    // Worn state ignored in the comparison: the plain copies just set are not seen as worn yet.
    applyInventory(ac, newInventory, false, true);
    gmTrace('login', 'equipment applied', {
      plain: newInventory.entries.filter(plain).map((x) => x.baseId.toString(16)),
      detailed: newInventory.entries.filter((e) => !plain(e)).map((x) => x.baseId.toString(16)),
    });
  } else setInventory(ac.getFormID(), newInventory);

  syncSpellEquipment(ac, eq.leftSpell, SpellType.Left);
  syncSpellEquipment(ac, eq.rightSpell, SpellType.Right);
  syncSpellEquipment(ac, eq.voiceSpell, SpellType.Voice);
  syncSpellEquipment(ac, eq.instantSpell, SpellType.Instant);

  return true;
};

export const isBadMenuShown = (): boolean => {
  return (
    Ui.isMenuOpen('InventoryMenu') ||
    Ui.isMenuOpen('FavoritesMenu') ||
    Ui.isMenuOpen('MagicMenu') ||
    Ui.isMenuOpen('ContainerMenu') ||
    Ui.isMenuOpen('Crafting Menu') // Actually I don't think it causes crashes
  );
};
