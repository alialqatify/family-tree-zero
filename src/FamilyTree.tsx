import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RawNodeDatum, CustomNodeElementProps } from 'react-d3-tree';
import { hierarchy, tree as d3tree } from 'd3-hierarchy';
import {
  Loader2,
  AlertCircle,
  Search,
  ArrowRight,
  X,
  Users,
  GitBranch,
  UserRound,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

/* =========================================================
   Types
========================================================= */

interface Person {
  id: string;
  display_id: string | null;
  full_name: string | null;
  family_title: string | null;
  gender: string | null;
  father_id: string | null;
  is_external: boolean | null;
  life_status: 'حي' | 'متوفى' | 'شهيد' | null;
  phone_number: string | null;
  photo_url: string | null;
  family_origin_id: string | null;
}

interface Marriage {
  marriage_id: string;
  husband_id: string | null;
  wife_id: string | null;
  status: string | null;
}

interface ChildLink {
  child_id: string;
  marriage_id: string;
}

interface TreeNode extends RawNodeDatum {
  name: string;
  attributes: {
    id: string;
    title: string;
    status: string;
  };
  children: TreeNode[];
}

interface ModalPerson {
  person: Person;
}

interface SpouseWithMarriage {
  person: Person;
  marriageId: string;
}

interface RelationFamily {
  person: Person;
  spouses: SpouseWithMarriage[];
  childrenBySpouse: Map<string, Person[]>;
}

type LoadState = 'loading' | 'success' | 'empty' | 'error';

type RelationView = {
  person: Person;
  parent: Person | null;
  siblings: Person[];
  ownFamily: RelationFamily;
  siblingFamilies: RelationFamily[];
};

interface RadialNode {
  id: string;
  name: string;
  children: RadialNode[];
}

interface LayoutPosition {
  x: number;
  y: number;
}

interface LayoutOptions {
  levelHeight?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  minNodeGap?: number;
}

/* =========================================================
   Helpers
========================================================= */

function personName(person: Person | null | undefined): string {
  return person?.full_name?.trim() || '—';
}

function isFemale(person: Person | null | undefined): boolean {
  return (
    String(person?.gender || '').toLowerCase() === 'female' ||
    String(person?.gender || '').toLowerCase() === 'أنثى' ||
    String(person?.gender || '').toLowerCase() === 'f'
  );
}

function isMale(person: Person | null | undefined): boolean {
  return (
    String(person?.gender || '').toLowerCase() === 'male' ||
    String(person?.gender || '').toLowerCase() === 'ذكر' ||
    String(person?.gender || '').toLowerCase() === 'm'
  );
}

function isDeceased(person: Person | null | undefined): boolean {
  return (
    person?.life_status === 'متوفى' ||
    person?.life_status === 'شهيد'
  );
}

function uniquePeople(people: Person[]): Person[] {
  const map = new Map<string, Person>();
  for (const person of people) {
    if (person?.id) {
      map.set(person.id, person);
    }
  }
  return Array.from(map.values());
}

function generateColor(index: number): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#FF8A94', '#A8E6CF', '#FFD3B4', '#B5B8C3',
    '#F7DC6F', '#BB8FCE',
  ];
  return colors[index % colors.length];
}

function getMother(
  person: Person,
  marriages: Marriage[],
  childrenLinks: ChildLink[],
  personMap: Map<string, Person>
): Person | null {
  if (!person.father_id) return null;
  for (const marriage of marriages) {
    if (marriage.husband_id === person.father_id) {
      const relatedLinks = childrenLinks.filter(
        (link) => link.marriage_id === marriage.marriage_id
      );
      if (relatedLinks.some((link) => link.child_id === person.id)) {
        if (marriage.wife_id) {
          return personMap.get(marriage.wife_id) || null;
        }
      }
    }
  }
  return null;
}

function getChildrenOfPerson(
  person: Person,
  allPeople: Person[],
  marriages: Marriage[],
  childrenLinks: ChildLink[],
  personMap: Map<string, Person>
): Person[] {
  const children: Person[] = [];
  for (const p of allPeople) {
    if (p.father_id === person.id) {
      children.push(p);
    }
  }
  const personMarriages = marriages.filter(
    (m) => m.husband_id === person.id || m.wife_id === person.id
  );
  for (const marriage of personMarriages) {
    const links = childrenLinks.filter(
      (link) => link.marriage_id === marriage.marriage_id
    );
    for (const link of links) {
      const child = personMap.get(link.child_id);
      if (child) children.push(child);
    }
  }
  return uniquePeople(children);
}

function getSisters(
  person: Person,
  allPeople: Person[],
  marriages: Marriage[],
  childrenLinks: ChildLink[],
  personMap: Map<string, Person>
): { sister: Person; color: string; children: Person[] }[] {
  if (!person.father_id) return [];
  const sisters = allPeople.filter(
    (p) =>
      p.father_id === person.father_id &&
      isFemale(p) &&
      p.id !== person.id
  );
  return sisters.map((sister, index) => ({
    sister,
    color: generateColor(index + 100),
    children: getChildrenOfPerson(sister, allPeople, marriages, childrenLinks, personMap),
  }));
}

function getSistersOfMother(
  person: Person,
  allPeople: Person[],
  marriages: Marriage[],
  childrenLinks: ChildLink[],
  personMap: Map<string, Person>
): { sister: Person; color: string; children: Person[] }[] {
  const mother = getMother(person, marriages, childrenLinks, personMap);
  if (!mother || !mother.father_id) return [];

  const sisters = allPeople.filter(
    (p) =>
      p.father_id === mother.father_id &&
      isFemale(p) &&
      p.id !== mother.id
  );

  return sisters.map((sister, index) => ({
    sister,
    color: generateColor(index),
    children: getChildrenOfPerson(sister, allPeople, marriages, childrenLinks, personMap),
  }));
}

function isPersonInFamily(
  personId: string,
  ancestorId: string,
  allPeople: Person[],
  marriages: Marriage[],
  childrenLinks: ChildLink[],
  personMap: Map<string, Person>
): boolean {
  const ancestor = personMap.get(ancestorId);
  if (!ancestor) return false;
  const ancestorChildren = getChildrenOfPerson(ancestor, allPeople, marriages, childrenLinks, personMap);
  if (ancestorChildren.some((c) => c.id === personId)) return true;

  for (const child of ancestorChildren) {
    const grandchildren = getChildrenOfPerson(child, allPeople, marriages, childrenLinks, personMap);
    if (grandchildren.some((gc) => gc.id === personId)) return true;
  }
  return false;
}

/* =========================================================
   Layout Engine – خوارزمية Buchheim (Reingold–Tilford) مع مسافة متغيرة حسب العمق
========================================================= */

interface BNode {
  node: TreeNode;
  id: string;
  children: BNode[];
  parent: BNode | null;
  number: number; // ترتيب بين الإخوة (1-based)
  depth: number;

  x: number;
  mod: number;
  thread: BNode | null;
  ancestorRef: BNode;
  change: number;
  shift: number;

  finalX: number;
  finalY: number;
}

function buildBNode(
  node: TreeNode,
  depth: number,
  parent: BNode | null,
  number: number
): BNode {
  const b: BNode = {
    node,
    id: node.attributes.id,
    children: [],
    parent,
    number,
    depth,
    x: 0,
    mod: 0,
    thread: null,
    ancestorRef: null as any,
    change: 0,
    shift: 0,
    finalX: 0,
    finalY: 0,
  };
  b.ancestorRef = b;
  b.children = (node.children || []).map((c, i) => buildBNode(c, depth + 1, b, i + 1));
  return b;
}

function leftSibling(v: BNode): BNode | null {
  if (!v.parent) return null;
  return v.number > 1 ? v.parent.children[v.number - 2] : null;
}

function leftmostChild(v: BNode): BNode | null {
  return v.children.length ? v.children[0] : null;
}

function rightmostChild(v: BNode): BNode | null {
  return v.children.length ? v.children[v.children.length - 1] : null;
}

function nextRightContour(v: BNode): BNode | null {
  return v.children.length ? rightmostChild(v) : v.thread;
}

function nextLeftContour(v: BNode): BNode | null {
  return v.children.length ? leftmostChild(v) : v.thread;
}

function moveSubtree(wLeft: BNode, wRight: BNode, shift: number): void {
  const subtrees = wRight.number - wLeft.number;
  if (subtrees === 0) return;
  wRight.change -= shift / subtrees;
  wRight.shift += shift;
  wLeft.change += shift / subtrees;
  wRight.x += shift;
  wRight.mod += shift;
}

function ancestorOf(vIm: BNode, v: BNode, defaultAncestor: BNode): BNode {
  if (v.parent && v.parent.children.includes(vIm.ancestorRef)) {
    return vIm.ancestorRef;
  }
  return defaultAncestor;
}

function apportion(v: BNode, defaultAncestor: BNode, distanceFn: (depth: number) => number): BNode {
  const w = leftSibling(v);
  if (!w || !v.parent) return defaultAncestor;

  let vIp = v, vOp = v, vIm = w, vOm = v.parent.children[0];
  let sIp = v.mod, sOp = v.mod, sIm = vIm.mod, sOm = vOm.mod;

  let nr = nextRightContour(vIm);
  let nl = nextLeftContour(vIp);

  while (nr && nl) {
    vIm = nr;
    vIp = nl;
    vOm = nextLeftContour(vOm)!;
    vOp = nextRightContour(vOp)!;
    vOp.ancestorRef = v;

    const shift = (vIm.x + sIm) - (vIp.x + sIp) + distanceFn(v.depth);
    if (shift > 0) {
      moveSubtree(ancestorOf(vIm, v, defaultAncestor), v, shift);
      sIp += shift;
      sOp += shift;
    }
    sIm += vIm.mod;
    sIp += vIp.mod;
    sOm += vOm.mod;
    sOp += vOp.mod;

    nr = nextRightContour(vIm);
    nl = nextLeftContour(vIp);
  }

  if (nr && !nextRightContour(vOp)) {
    vOp.thread = nr;
    vOp.mod += sIm - sOp;
  }
  if (nl && !nextLeftContour(vOm)) {
    vOm.thread = nl;
    vOm.mod += sIp - sOm;
    defaultAncestor = v;
  }
  return defaultAncestor;
}

function executeShifts(v: BNode): void {
  let shift = 0;
  let change = 0;
  for (let i = v.children.length - 1; i >= 0; i--) {
    const w = v.children[i];
    w.x += shift;
    w.mod += shift;
    change += w.change;
    shift += w.shift + change;
  }
}

function firstWalk(v: BNode, distanceFn: (depth: number) => number): void {
  if (v.children.length === 0) {
    const sib = leftSibling(v);
    v.x = sib ? sib.x + distanceFn(v.depth) : 0;
  } else {
    let defaultAncestor = v.children[0];
    for (const w of v.children) {
      firstWalk(w, distanceFn);
      defaultAncestor = apportion(w, defaultAncestor, distanceFn);
    }
    executeShifts(v);
    const first = v.children[0];
    const last = v.children[v.children.length - 1];
    const midpoint = (first.x + last.x) / 2;
    const sib = leftSibling(v);
    if (sib) {
      v.x = sib.x + distanceFn(v.depth);
      v.mod = v.x - midpoint;
    } else {
      v.x = midpoint;
    }
  }
}

function secondWalk(v: BNode, modSum: number, levelHeight: number): void {
  v.finalX = v.x + modSum;
  v.finalY = -v.depth * levelHeight;
  for (const child of v.children) {
    secondWalk(child, modSum + v.mod, levelHeight);
  }
}

function collectFinal(v: BNode, result: Map<string, LayoutPosition>): void {
  result.set(v.id, { x: v.finalX, y: v.finalY });
  for (const child of v.children) collectFinal(child, result);
}

function subtreeExtent(v: BNode): { min: number; max: number } {
  let min = v.finalX, max = v.finalX;
  for (const child of v.children) {
    const e = subtreeExtent(child);
    min = Math.min(min, e.min);
    max = Math.max(max, e.max);
  }
  return { min, max };
}

function shiftFinal(v: BNode, dx: number): void {
  v.finalX += dx;
  for (const child of v.children) shiftFinal(child, dx);
}

function maxDepthOf(v: BNode): number {
  if (v.children.length === 0) return v.depth;
  return Math.max(...v.children.map(maxDepthOf));
}

function computeOrganicLayout(
  roots: TreeNode[],
  options: LayoutOptions = {}
): Map<string, LayoutPosition> {
  const { levelHeight = 160, nodeWidth = 140, minNodeGap = 25 } = options;
  const result = new Map<string, LayoutPosition>();
  if (roots.length === 0) return result;

  const baseDistance = nodeWidth + minNodeGap;
  const bRoots = roots.map((r) => buildBNode(r, 0, null, 1));
  const overallMaxDepth = Math.max(...bRoots.map(maxDepthOf), 1);

  const distanceFn = (depth: number) => {
    const t = Math.min(1, depth / overallMaxDepth);
    const factor = 0.5 + 0.5 * t;
    return baseDistance * factor;
  };

  let cursor = 0;
  for (const bRoot of bRoots) {
    firstWalk(bRoot, distanceFn);
    secondWalk(bRoot, 0, levelHeight);
    const { min, max } = subtreeExtent(bRoot);
    if (min < cursor) {
      shiftFinal(bRoot, cursor - min);
    }
    const { max: newMax } = subtreeExtent(bRoot);
    cursor = newMax + baseDistance * 1.5;
    collectFinal(bRoot, result);
  }

  return result;
}

/* =========================================================
   دوال الإزاحة الرأسية – تربط الارتفاع بحجم الفرع مع سقف أقصى
========================================================= */

function hashToUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function countDescendants(node: TreeNode): number {
  let count = 0;
  for (const child of node.children) {
    count += 1 + countDescendants(child);
  }
  return count;
}

function applyBranchHeightOffset(
  roots: TreeNode[],
  positions: Map<string, LayoutPosition>,
  amount: number,
  levelHeight: number
): Map<string, LayoutPosition> {
  const result = new Map(positions);
  const maxSafeOffset = levelHeight * 0.48;
  const safeAmount = Math.min(Math.max(amount, 0), maxSafeOffset);

  function walk(node: TreeNode, cumulativeOffset: number): void {
    const pos = result.get(node.attributes.id);
    if (pos) {
      result.set(node.attributes.id, { x: pos.x, y: pos.y + cumulativeOffset });
    }

    if (node.children.length === 0) return;

    const counts = node.children.map(countDescendants);
    const maxCount = Math.max(...counts, 1);
    for (const [index, child] of node.children.entries()) {
      const branchRatio = Math.sqrt(counts[index] / maxCount);
      const naturalVariation = 0.82 + hashToUnit(child.attributes.id) * 0.18;
      const offset = safeAmount * branchRatio * naturalVariation;
      walk(child, cumulativeOffset - offset);
    }
  }

  for (const root of roots) walk(root, 0);
  return result;
}

/* =========================================================
   دالة حساب الاحتواء التلقائي
========================================================= */

function computeFitZoom(
  positions: Map<string, LayoutPosition>,
  viewportW: number,
  viewportH: number
) {
  if (positions.size === 0 || viewportW <= 0 || viewportH <= 0) {
    return { zoom: 1, translate: { x: viewportW / 2 || 300, y: 60 } };
  }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const treeW = maxX - minX + 240;
  const treeH = maxY - minY + 240;
  const fitZoom = Math.min(viewportW / treeW, viewportH / treeH, 1.2);
  const clampedZoom = Math.max(0.15, fitZoom);
  return {
    zoom: clampedZoom,
    translate: {
      x: viewportW / 2 - ((minX + maxX) / 2) * clampedZoom,
      y: 80 - minY * clampedZoom,
    },
  };
}

function findPath(roots: TreeNode[], targetId: string): string[] | null {
  const dfs = (node: TreeNode, path: string[]): string[] | null => {
    if (node.attributes.id === targetId) {
      return [...path, node.attributes.id];
    }
    for (const child of node.children) {
      const result = dfs(child, [...path, node.attributes.id]);
      if (result) return result;
    }
    return null;
  };
  for (const root of roots) {
    const result = dfs(root, []);
    if (result) return result;
  }
  return null;
}

function buildVisibleData(
  roots: TreeNode[],
  collapsedIds: Set<string>
): TreeNode[] {
  const clone = (node: TreeNode): TreeNode => ({
    ...node,
    attributes: { ...node.attributes },
    children: collapsedIds.has(node.attributes.id)
      ? []
      : node.children.map(clone),
  });
  return roots.map(clone);
}

/* =========================================================
   Component
========================================================= */

export default function FamilyTree() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [marriages, setMarriages] = useState<Marriage[]>([]);
  const [childrenLinks, setChildrenLinks] = useState<ChildLink[]>([]);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMessage, setSearchMessage] = useState('');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<ModalPerson | null>(null);
  const [relationPerson, setRelationPerson] = useState<Person | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [treeKey, setTreeKey] = useState('tree-initial');
  const [relationOpen, setRelationOpen] = useState(false);

  const [selectedSisterId, setSelectedSisterId] = useState<string | null>(null);
  const [selectedAuntId, setSelectedAuntId] = useState<string | null>(null);
  const [showAllSisters, setShowAllSisters] = useState(false);
  const [showAllAunts, setShowAllAunts] = useState(false);
  const [sistersInfo, setSistersInfo] = useState<
    { sister: Person; color: string; children: Person[] }[]
  >([]);
  const [auntsInfo, setAuntsInfo] = useState<
    { sister: Person; color: string; children: Person[] }[]
  >([]);

  const [radialOpen, setRadialOpen] = useState(false);
  const [radialRoot, setRadialRoot] = useState<RadialNode | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

  // --- متغيرات التحكم الحي (Tuner) ---
  const [branchOffset, setBranchOffset] = useState(58);
  const [showTuner, setShowTuner] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const currentZoomRef = useRef(1);

  /* Load Data */
  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoadState('loading');
      setErrorMsg('');

      const [peopleResult, marriagesResult, childrenResult] = await Promise.all([
        supabase.from('people').select(`
            id, display_id, full_name, family_title, gender, father_id,
            is_external, life_status, phone_number, photo_url, family_origin_id
          `),
        supabase.from('marriages').select(`marriage_id, husband_id, wife_id, status`),
        supabase.from('children_link').select(`child_id, marriage_id`),
      ]);

      if (cancelled) return;

      if (peopleResult.error || marriagesResult.error || childrenResult.error) {
        setErrorMsg('فشل تحميل البيانات من السيرفر');
        setLoadState('error');
        return;
      }

      const loadedPeople = (peopleResult.data || []) as Person[];
      const loadedMarriages = (marriagesResult.data || []) as Marriage[];
      const loadedChildren = (childrenResult.data || []) as ChildLink[];

      if (loadedPeople.length === 0) {
        setLoadState('empty');
        return;
      }

      setPeople(loadedPeople);
      setMarriages(loadedMarriages);
      setChildrenLinks(loadedChildren);

      const externalIds = new Set(
        loadedPeople.filter((p) => p.is_external).map((p) => p.id)
      );
      const malePeople = loadedPeople.filter((p) => isMale(p) && !p.is_external);
      const nodeMap = new Map<string, TreeNode>();
      for (const person of malePeople) {
        nodeMap.set(person.id, {
          name: person.full_name?.trim() || '—',
          attributes: {
            id: person.id,
            title: person.family_title || '',
            status: person.life_status || '',
          },
          children: [],
        });
      }

      const roots: TreeNode[] = [];
      for (const person of malePeople) {
        const node = nodeMap.get(person.id);
        if (!node) continue;
        if (person.father_id && nodeMap.has(person.father_id)) {
          nodeMap.get(person.father_id)!.children.push(node);
        } else if (person.father_id && externalIds.has(person.father_id)) {
          continue;
        } else {
          roots.push(node);
        }
      }

      if (roots.length === 0) {
        setLoadState('empty');
        return;
      }

      setTreeData(roots);
      setLoadState('success');
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Resize Observer */
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setDimensions({ width, height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [loadState]);

  /* ESC key */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSelectedPerson(null);
      setRelationOpen(false);
      setRadialOpen(false);
      setSelectedSisterId(null);
      setSelectedAuntId(null);
      setShowAllSisters(false);
      setShowAllAunts(false);
      setSelectedHighlightId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /* Maps */
  const personMap = useMemo(() => {
    const map = new Map<string, Person>();
    for (const person of people) map.set(person.id, person);
    return map;
  }, [people]);

  const marriagesByPerson = useMemo(() => {
    const map = new Map<string, Marriage[]>();
    for (const marriage of marriages) {
      if (marriage.husband_id) {
        const list = map.get(marriage.husband_id) || [];
        list.push(marriage);
        map.set(marriage.husband_id, list);
      }
      if (marriage.wife_id) {
        const list = map.get(marriage.wife_id) || [];
        list.push(marriage);
        map.set(marriage.wife_id, list);
      }
    }
    return map;
  }, [marriages]);

  const childrenByMarriage = useMemo(() => {
    const map = new Map<string, Person[]>();
    for (const link of childrenLinks) {
      const child = personMap.get(link.child_id);
      if (!child) continue;
      const list = map.get(link.marriage_id) || [];
      list.push(child);
      map.set(link.marriage_id, list);
    }
    return map;
  }, [childrenLinks, personMap]);

  /* Relationships */
  const getSpousesWithMarriage = useCallback(
    (personId: string): SpouseWithMarriage[] => {
      const result: SpouseWithMarriage[] = [];
      const list = marriagesByPerson.get(personId) || [];
      for (const marriage of list) {
        let spouseId: string | null = null;
        if (marriage.husband_id === personId) spouseId = marriage.wife_id;
        else if (marriage.wife_id === personId) spouseId = marriage.husband_id;
        if (!spouseId) continue;
        const spouse = personMap.get(spouseId);
        if (spouse) result.push({ person: spouse, marriageId: marriage.marriage_id });
      }
      return result;
    },
    [marriagesByPerson, personMap]
  );

  const getChildren = useCallback(
    (personId: string): Person[] => {
      const result: Person[] = [];
      for (const person of people) {
        if (person.father_id === personId) result.push(person);
      }
      const list = marriagesByPerson.get(personId) || [];
      for (const m of list) {
        const children = childrenByMarriage.get(m.marriage_id) || [];
        result.push(...children);
      }
      return uniquePeople(result);
    },
    [people, marriagesByPerson, childrenByMarriage]
  );

  const getParent = useCallback(
    (person: Person): Person | null => {
      if (!person.father_id) return null;
      return personMap.get(person.father_id) || null;
    },
    [personMap]
  );

  const getSiblings = useCallback(
    (person: Person): Person[] => {
      if (!person.father_id) return [];
      return people.filter(
        (candidate) =>
          candidate.id !== person.id && candidate.father_id === person.father_id
      );
    },
    [people]
  );

  const buildFamily = useCallback(
    (person: Person): RelationFamily => {
      const spousesWithMarriage = getSpousesWithMarriage(person.id);
      const childrenBySpouse = new Map<string, Person[]>();
      for (const { marriageId } of spousesWithMarriage) {
        const children = childrenByMarriage.get(marriageId) || [];
        childrenBySpouse.set(marriageId, children);
      }
      return { person, spouses: spousesWithMarriage, childrenBySpouse };
    },
    [getSpousesWithMarriage, childrenByMarriage]
  );

  const buildRelationView = useCallback(
    (person: Person): RelationView => {
      const siblings = getSiblings(person);
      const siblingFamilies = siblings.map((sibling) => buildFamily(sibling));
      return {
        person,
        parent: getParent(person),
        siblings,
        ownFamily: buildFamily(person),
        siblingFamilies,
      };
    },
    [getSiblings, getParent, buildFamily]
  );

  const relationView = useMemo(() => {
    if (!relationPerson) return null;
    return buildRelationView(relationPerson);
  }, [relationPerson, buildRelationView]);

  const nodesWithChildren = useMemo(() => {
    const result = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) result.add(node.attributes.id);
        walk(node.children);
      }
    };
    walk(treeData);
    return result;
  }, [treeData]);

  const visibleData = useMemo(
    () => buildVisibleData(treeData, collapsedIds),
    [treeData, collapsedIds]
  );

  /* التخطيط مع تطبيق إزاحة الأفرع المرتبطة بحجم الفرع */
  const organicLayout = useMemo(() => {
    const raw = computeOrganicLayout(visibleData, {
      levelHeight: 160,
      nodeWidth: 140,
      nodeHeight: 60,
      minNodeGap: 25,
    });
    return applyBranchHeightOffset(visibleData, raw, branchOffset, 160);
  }, [visibleData, branchOffset]);

  useEffect(() => {
    if (treeKey !== 'tree-initial') return;
    if (dimensions.width === 0 || organicLayout.size === 0) return;
    const fit = computeFitZoom(organicLayout, dimensions.width, dimensions.height);
    setZoom(fit.zoom);
    currentZoomRef.current = fit.zoom;
    setTranslate(fit.translate);
  }, [dimensions, organicLayout, treeKey]);

  /* رسم المسارات */
  const linkPaths = useMemo(() => {
    const paths: { path: string; strokeWidth: number }[] = [];
    const walk = (node: TreeNode, parentId: string | null) => {
      if (parentId) {
        const s = organicLayout.get(parentId);
        const t = organicLayout.get(node.attributes.id);
        if (s && t) {
          const midY = (s.y + t.y) / 2;
          const curve = (hashToUnit(`${parentId}:${node.attributes.id}`) - 0.5) * 34;
          const midX1 = s.x + curve;
          const midX2 = t.x - curve * 0.65;
          paths.push({
            path: `M${s.x},${s.y} C${midX1},${midY} ${midX2},${midY} ${t.x},${t.y}`,
            strokeWidth: Math.min(14, 2.5 + Math.sqrt(countDescendants(node)) * 0.75),
          });
        }
      }
      for (const child of node.children) {
        walk(child, node.attributes.id);
      }
    };

    for (const root of visibleData) {
      walk(root, null);
    }
    return paths;
  }, [visibleData, organicLayout]);

  const allPositionedNodes = useMemo(() => {
    const map = new Map<string, { datum: TreeNode }>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        map.set(n.attributes.id, { datum: n });
        walk(n.children);
      }
    };
    walk(visibleData);
    return map;
  }, [visibleData]);

  /* Search */
  const searchResults = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];
    return people
      .filter((person) => personName(person).toLowerCase().includes(term))
      .slice(0, 8);
  }, [searchTerm, people]);

  const focusMaleOnTree = useCallback(
    (personId: string) => {
      const path = findPath(treeData, personId);
      if (!path) return;
      const newCollapsedIds = new Set(collapsedIds);
      for (const id of path) newCollapsedIds.delete(id);
      const expandedData = buildVisibleData(treeData, newCollapsedIds);
      const expandedLayout = applyBranchHeightOffset(
        expandedData,
        computeOrganicLayout(expandedData, {
          levelHeight: 160,
          nodeWidth: 140,
          nodeHeight: 60,
          minNodeGap: 25,
        }),
        branchOffset,
        160,
      );
      const targetPos = expandedLayout.get(personId) ?? null;
      setCollapsedIds(newCollapsedIds);
      setHighlightId(personId);
      setSelectedHighlightId(personId);
      if (targetPos && dimensions.width > 0) {
        const z = currentZoomRef.current;
        setTranslate({
          x: dimensions.width / 2 - targetPos.x * z,
          y: dimensions.height / 2 - targetPos.y * z,
        });
        setZoom(z);
        setTreeKey(`tree-${personId}-${Date.now()}`);
      }
    },
    [treeData, collapsedIds, dimensions, branchOffset]
  );

  const handleSelectSearchResult = useCallback(
    (person: Person) => {
      setSearchTerm(personName(person));
      setSearchMessage('');
      if (isMale(person)) {
        focusMaleOnTree(person.id);
        setRelationPerson(person);
        setSelectedPerson({ person });
        return;
      }
      if (person.father_id) {
        const father = personMap.get(person.father_id);
        if (father && isMale(father)) {
          focusMaleOnTree(father.id);
        }
      }
      setRelationPerson(person);
      setSelectedPerson({ person });
    },
    [focusMaleOnTree, personMap]
  );

  const handleSearch = useCallback(() => {
    const term = searchTerm.trim();
    if (!term) {
      setSearchMessage('اكتب اسم الشخص أولًا');
      return;
    }
    const match =
      people.find(
        (person) => personName(person).toLowerCase() === term.toLowerCase()
      ) ||
      people.find((person) =>
        personName(person).toLowerCase().includes(term.toLowerCase())
      );
    if (!match) {
      setSearchMessage('لم يُعثر على الاسم');
      return;
    }
    handleSelectSearchResult(match);
  }, [searchTerm, people, handleSelectSearchResult]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedPerson) {
      const sisters = getSisters(selectedPerson.person, people, marriages, childrenLinks, personMap);
      setSistersInfo(sisters);
      const aunts = getSistersOfMother(selectedPerson.person, people, marriages, childrenLinks, personMap);
      setAuntsInfo(aunts);
      setSelectedSisterId(null);
      setSelectedAuntId(null);
      setShowAllSisters(false);
      setShowAllAunts(false);
    } else {
      setSistersInfo([]);
      setAuntsInfo([]);
      setSelectedSisterId(null);
      setSelectedAuntId(null);
      setShowAllSisters(false);
      setShowAllAunts(false);
    }
  }, [selectedPerson, people, marriages, childrenLinks, personMap]);

  /* Custom Leaf Node */
  const renderNode = useCallback(
    (props: CustomNodeElementProps) => {
      const { nodeDatum } = props;
      const id = nodeDatum.attributes?.id as string;
      const title = nodeDatum.attributes?.title as string | undefined;
      const status = nodeDatum.attributes?.status as string | undefined;
      const isDead = status === 'متوفى' || status === 'شهيد';
      const hasChildren = nodesWithChildren.has(id);
      const isCollapsed = hasChildren && (nodeDatum.children?.length ?? 0) === 0;
      const isHighlighted = highlightId === id;
      const isSelected = selectedHighlightId === id;
      const person = personMap.get(id);

      let sisterColor: string | null = null;
      if (selectedPerson) {
        if (showAllSisters) {
          for (const info of sistersInfo) {
            if (isPersonInFamily(id, info.sister.id, people, marriages, childrenLinks, personMap)) {
              sisterColor = info.color;
              break;
            }
          }
        } else if (selectedSisterId) {
          const found = sistersInfo.find((info) => info.sister.id === selectedSisterId);
          if (found && isPersonInFamily(id, selectedSisterId, people, marriages, childrenLinks, personMap)) {
            sisterColor = found.color;
          }
        }
      }

      let auntColor: string | null = null;
      if (selectedPerson) {
        if (showAllAunts) {
          for (const info of auntsInfo) {
            if (isPersonInFamily(id, info.sister.id, people, marriages, childrenLinks, personMap)) {
              auntColor = info.color;
              break;
            }
          }
        } else if (selectedAuntId) {
          const found = auntsInfo.find((info) => info.sister.id === selectedAuntId);
          if (found && isPersonInFamily(id, selectedAuntId, people, marriages, childrenLinks, personMap)) {
            auntColor = found.color;
          }
        }
      }

      const finalColor = auntColor || sisterColor;

      const handlePointerDown = (event: React.PointerEvent) => {
        event.currentTarget.setAttribute('data-dx', String(event.clientX));
        event.currentTarget.setAttribute('data-dy', String(event.clientY));
      };

      const handlePointerUp = (event: React.PointerEvent) => {
        const dx = parseFloat(event.currentTarget.getAttribute('data-dx') || '0');
        const dy = parseFloat(event.currentTarget.getAttribute('data-dy') || '0');
        const moved = Math.sqrt((event.clientX - dx) ** 2 + (event.clientY - dy) ** 2) > 10;
        if (moved) return;
        const target = event.target as SVGElement;
        const isArrow = target.getAttribute('data-arrow') === 'true';
        if (isArrow && hasChildren) {
          toggleCollapse(id);
          return;
        }
        if (person) {
          setRelationPerson(person);
          setSelectedPerson({ person });
          setSelectedHighlightId(person.id);
        }
      };

      const nameWidth = nodeDatum.name.length * 9 + (isDead ? 65 : 0) + 28;
      const titleWidth = title ? title.length * 8 + 28 : 80;
      const rectWidth = Math.max(nameWidth, titleWidth, 100);
      const rectHeight = title ? 46 : 32;

      const leafW = rectWidth * 1.25;
      const leafH = rectHeight * 1.6;
      const leafPath = `M${-leafW / 2},0 Q0,${-leafH / 2} ${leafW / 2},0 Q0,${leafH / 2} ${-leafW / 2},0 Z`;

      return (
        <g
          data-person-id={id}
          transform={`rotate(${(hashToUnit(id) - 0.5) * 14})`}
          style={{ cursor: 'pointer' }}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onClick={(event) => event.stopPropagation()}
        >
          {isSelected && !isHighlighted && (
            <rect
              x={-rectWidth / 2 - 7}
              y={-rectHeight / 2 - 7}
              width={rectWidth + 14}
              height={rectHeight + 14}
              rx={10}
              fill="#f1f5f9"
              stroke="#64748b"
              strokeWidth={3}
            />
          )}

          {isHighlighted && (
            <rect
              x={-rectWidth / 2 - 7}
              y={-rectHeight / 2 - 7}
              width={rectWidth + 14}
              height={rectHeight + 14}
              rx={10}
              fill="#fef3c7"
              stroke="#eab308"
              strokeWidth={3}
            />
          )}

          <path
            className="leaf-node-shape"
            d={leafPath}
            fill={finalColor ? `${finalColor}33` : 'rgba(134, 239, 172, 0.28)'}
            stroke={
              isHighlighted
                ? '#eab308'
                : isSelected
                ? '#64748b'
                : finalColor
                ? finalColor
                : '#4ade80'
            }
            strokeWidth={isHighlighted || isSelected ? 2 : finalColor ? 2 : 1.3}
          />

          <text
            x="0"
            y={title ? -7 : 5}
            textAnchor="middle"
            fill="#1e3a8a"
            fontSize="15"
            fontWeight="600"
            style={{ fontFamily: 'Cairo, sans-serif' }}
          >
            {nodeDatum.name}
            {isDead && (
              <tspan fill="#64748b" fontSize="11" dx="4" fontWeight="400">
                (رحمه الله)
              </tspan>
            )}
          </text>

          {title && (
            <text
              x="0"
              y="14"
              textAnchor="middle"
              fill="#64748b"
              fontSize="11"
              style={{ fontFamily: 'Cairo, sans-serif' }}
            >
              {title}
            </text>
          )}

          {hasChildren && (
            <g
              data-arrow="true"
              transform={`translate(${rectWidth / 2 + 8}, 0)`}
            >
              <circle r={9} fill="#1e40af" data-arrow="true" />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fill="#ffffff"
                fontSize="10"
                fontWeight="700"
                data-arrow="true"
              >
                {isCollapsed ? '▶' : '▼'}
              </text>
            </g>
          )}
        </g>
      );
    },
    [
      nodesWithChildren,
      highlightId,
      selectedHighlightId,
      personMap,
      toggleCollapse,
      selectedSisterId,
      selectedAuntId,
      showAllSisters,
      showAllAunts,
      selectedPerson,
      sistersInfo,
      auntsInfo,
      people,
      marriages,
      childrenLinks,
    ]
  );

  const openRelations = useCallback((person: Person) => {
    setSelectedPerson(null);
    setRelationPerson(person);
    setRelationOpen(true);
  }, []);

  const RelationPersonNode = ({
    person,
    role,
    compact = false,
    onClick,
  }: {
    person: Person;
    role?: string;
    compact?: boolean;
    onClick?: () => void;
  }) => {
    const dead = isDeceased(person);
    return (
      <button
        type="button"
        onClick={onClick}
        className={[
          'relative flex flex-col items-center justify-center',
          'rounded-xl border bg-white shadow-sm',
          'transition-all hover:-translate-y-0.5 hover:shadow-md',
          compact ? 'min-w-[110px] px-3 py-2' : 'min-w-[145px] px-4 py-3',
          dead ? 'border-slate-300' : 'border-slate-200',
        ].join(' ')}
      >
        <span className="text-sm font-bold text-slate-800">{personName(person)}</span>
        {role && <span className="mt-1 text-[11px] text-slate-500">{role}</span>}
        {person.family_title && (
          <span className="mt-0.5 text-[10px] text-slate-400">{person.family_title}</span>
        )}
        {dead && <span className="mt-1 text-[10px] text-slate-400">{person.life_status}</span>}
      </button>
    );
  };

  const FamilyBranch = ({ family }: { family: RelationFamily }) => {
    const { person, spouses, childrenBySpouse } = family;
    if (spouses.length === 0) {
      const allChildren = Array.from(childrenBySpouse.values()).flat();
      return (
        <div className="flex flex-col items-center">
          <RelationPersonNode person={person} onClick={() => openRelations(person)} />
          {allChildren.length > 0 && (
            <>
              <div className="h-8 w-px bg-slate-300" />
              <div className="relative flex items-start gap-4 pt-4">
                <div className="absolute top-0 left-1/2 h-px w-[calc(100%-80px)] -translate-x-1/2 bg-slate-300" />
                {allChildren.map((child) => (
                  <div key={child.id} className="relative flex flex-col items-center">
                    <div className="absolute -top-4 h-4 w-px bg-slate-300" />
                    <RelationPersonNode
                      person={child}
                      role={isFemale(child) ? 'ابنة' : 'ابن'}
                      compact
                      onClick={() => openRelations(child)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center">
        <RelationPersonNode person={person} onClick={() => openRelations(person)} />
        <div className="mt-4 flex flex-col gap-6">
          {spouses.map(({ person: spouse, marriageId }) => {
            const children = childrenBySpouse.get(marriageId) || [];
            const spouseRole = isFemale(spouse) ? 'زوجة' : 'زوج';
            return (
              <div key={marriageId} className="flex flex-col items-center">
                <div className="flex items-center gap-2">
                  <div className="h-px w-8 bg-slate-300" />
                  <RelationPersonNode
                    person={spouse}
                    role={spouseRole}
                    compact
                    onClick={() => openRelations(spouse)}
                  />
                </div>
                {children.length > 0 && (
                  <>
                    <div className="h-6 w-px bg-slate-300" />
                    <div className="relative flex items-start gap-4 pt-4">
                      <div className="absolute top-0 left-1/2 h-px w-[calc(100%-80px)] -translate-x-1/2 bg-slate-300" />
                      {children.map((child) => (
                        <div key={child.id} className="relative flex flex-col items-center">
                          <div className="absolute -top-4 h-4 w-px bg-slate-300" />
                          <RelationPersonNode
                            person={child}
                            role={isFemale(child) ? 'ابنة' : 'ابن'}
                            compact
                            onClick={() => openRelations(child)}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const RelationDiagram = () => {
    if (!relationView) return null;
    const { person, parent, siblingFamilies, ownFamily } = relationView;
    return (
      <div
        className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[2px]"
        onClick={() => setRelationOpen(false)}
      >
        <div
          className="absolute inset-4 md:inset-8 bg-slate-50 rounded-2xl shadow-2xl overflow-hidden"
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center">
                <GitBranch className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800">العلاقات العائلية</h2>
                <p className="text-xs text-slate-500">{personName(person)}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRelationOpen(false)}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="absolute inset-x-0 bottom-0 top-16 overflow-auto p-6">
            <div className="min-w-max min-h-full flex flex-col items-center gap-8 pb-16">
              {parent && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-slate-500 mb-2">الأب</div>
                  <RelationPersonNode person={parent} onClick={() => openRelations(parent)} />
                  <div className="h-8 w-px bg-slate-300" />
                </div>
              )}
              <div className="flex flex-col items-center">
                <div className="ring-2 ring-blue-500 ring-offset-4 rounded-xl">
                  <RelationPersonNode person={person} role="الشخص المحدد" />
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div className="h-8 w-px bg-slate-300" />
                <div className="text-xs text-slate-500 mb-3">الأسرة والذرية</div>
                <FamilyBranch family={ownFamily} />
              </div>
              {siblingFamilies.length > 0 && (
                <div className="w-full">
                  <div className="flex items-center justify-center gap-3 mb-5">
                    <div className="h-px w-12 bg-slate-300" />
                    <span className="text-sm font-bold text-slate-700">الإخوة والأخوات وعائلاتهم</span>
                    <div className="h-px w-12 bg-slate-300" />
                  </div>
                  <div className="flex items-start justify-center gap-8 flex-wrap">
                    {siblingFamilies.map((family) => (
                      <FamilyBranch key={family.person.id} family={family} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* Radial Branch View */
  function buildRadialTree(
    rootPerson: Person,
    getChildrenFn: (id: string) => Person[],
    maxDepth = 6,
    maxNodes = 200
  ): RadialNode {
    let count = 0;
    const build = (person: Person, depth: number): RadialNode => {
      count++;
      const node: RadialNode = { id: person.id, name: personName(person), children: [] };
      if (depth < maxDepth && count < maxNodes) {
        const kids = getChildrenFn(person.id);
        for (const k of kids) {
          if (count >= maxNodes) break;
          node.children.push(build(k, depth + 1));
        }
      }
      return node;
    };
    return build(rootPerson, 0);
  }

  function polarToCartesian(angle: number, radius: number) {
    return {
      x: radius * Math.cos(angle - Math.PI / 2),
      y: radius * Math.sin(angle - Math.PI / 2),
    };
  }

  const RADIAL_STEP = 100;
  const RadialBranchView = ({
    root,
    onClose,
  }: {
    root: RadialNode;
    onClose: () => void;
  }) => {
    const { nodes, links, maxDepth } = useMemo(() => {
      const h = hierarchy<RadialNode>(root, (d) => d.children);
      const depth = h.height || 1;
      const radius = depth * RADIAL_STEP;
      const layout = d3tree<RadialNode>()
        .size([2 * Math.PI, radius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.6) / Math.max(a.depth, 1));

      layout(h);
      return { nodes: h.descendants(), links: h.links(), maxDepth: depth };
    }, [root]);

    const size = maxDepth * RADIAL_STEP * 2 + 200;
    const center = size / 2;

    return (
      <div
        className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[2px]"
        onClick={onClose}
      >
        <div
          className="absolute inset-4 md:inset-8 bg-white rounded-2xl shadow-2xl overflow-auto"
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="h-14 border-b border-slate-200 flex items-center justify-between px-4 shrink-0">
            <h2 className="font-bold text-slate-800">عرض شعاعي للفرع</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-4 overflow-auto flex justify-center">
            <svg width={size} height={size}>
              <g transform={`translate(${center},${center})`}>
                {links.map((link, i) => {
                  const s = polarToCartesian(link.source.x, link.source.y);
                  const t = polarToCartesian(link.target.x, link.target.y);
                  return (
                    <path
                      key={i}
                      d={`M${s.x},${s.y} Q${(s.x + t.x) / 2},${(s.y + t.y) / 2} ${t.x},${t.y}`}
                      fill="none"
                      stroke="#cbd5e1"
                      strokeWidth={1.3}
                    />
                  );
                })}
                {nodes.map((node) => {
                  const p = polarToCartesian(node.x, node.y);
                  const onRightHalf = Math.cos(node.x - Math.PI / 2) >= 0;
                  return (
                    <g key={node.data.id} transform={`translate(${p.x},${p.y})`}>
                      <circle r={5} fill={node.depth === 0 ? '#1e40af' : '#64748b'} />
                      <text
                        dy="0.32em"
                        x={onRightHalf ? 9 : -9}
                        textAnchor={onRightHalf ? 'start' : 'end'}
                        fontSize={12}
                        fill="#1e293b"
                        style={{ fontFamily: 'Cairo, sans-serif' }}
                      >
                        {node.data.name}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>
      </div>
    );
  };

  if (loadState === 'loading') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-sm text-slate-600">جاري تحميل بيانات العائلة…</p>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4">
        <AlertCircle className="w-8 h-8 text-red-600" />
        <p className="text-sm text-red-700 text-center max-w-xl">{errorMsg}</p>
      </div>
    );
  }

  if (loadState === 'empty') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4">
        <AlertCircle className="w-8 h-8 text-amber-500" />
        <p className="text-sm text-slate-600 text-center max-w-md">لا توجد بيانات ذكور لعرض الشجرة.</p>
      </div>
    );
  }

  return (
    <div dir="rtl" className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* Header */}
      <div className="relative z-20 bg-white border-b border-slate-200 px-3 md:px-4 py-3 flex items-center gap-3 flex-wrap shrink-0">
        <a href="#/" className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 shrink-0">
          <ArrowRight className="w-4 h-4" />
          لوحة التحكم
        </a>
        <h1 className="text-base font-bold text-slate-800 shrink-0">شجرة العائلة</h1>
        <div className="flex-1 min-w-[240px] max-w-xl mx-auto">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setSearchMessage('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder="ابحث عن أي شخص: رجل أو امرأة…"
              className="w-full pr-9 pl-20 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-400"
            />
            <button
              type="button"
              onClick={handleSearch}
              className="absolute left-1 top-1 bottom-1 px-3 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              بحث
            </button>
            {searchTerm.trim() && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden z-50">
                {searchResults.map((person) => (
                  <button
                    type="button"
                    key={person.id}
                    onClick={() => handleSelectSearchResult(person)}
                    className="w-full px-3 py-2.5 flex items-center gap-3 text-right hover:bg-slate-50 border-b last:border-b-0 border-slate-100"
                  >
                    <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                      <UserRound className="w-4 h-4 text-slate-500" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {personName(person)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {isFemale(person) ? 'أنثى' : 'ذكر'}
                        {person.family_title ? ` • ${person.family_title}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="hidden md:flex items-center gap-1 text-xs text-slate-400">
          <Users className="w-4 h-4" />
          <span>{people.length} شخص</span>
        </div>
      </div>

      {searchMessage && (
        <div className="relative z-10 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-700 text-center shrink-0">
          {searchMessage}
        </div>
      )}

      {/* الشجرة الرئيسي */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden bg-slate-50">
        {dimensions.width > 0 && visibleData.length > 0 && (
          <>
            <svg
              width={dimensions.width}
              height={dimensions.height}
              style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
              onPointerDown={(e) => {
                activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (activePointers.current.size === 2) {
                  const pts = Array.from(activePointers.current.values());
                  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                  pinchRef.current = { dist, zoom };
                  setIsDragging(false);
                  return;
                }
                if ((e.target as SVGElement).closest('[data-person-id]')) return;
                setIsDragging(true);
                dragStartRef.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y };
              }}
              onPointerMove={(e) => {
                if (activePointers.current.has(e.pointerId)) {
                  activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                }
                if (activePointers.current.size === 2 && pinchRef.current) {
                  const pts = Array.from(activePointers.current.values());
                  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                  const ratio = dist / pinchRef.current.dist;
                  const newZoom = Math.min(5, Math.max(0.1, pinchRef.current.zoom * ratio));
                  currentZoomRef.current = newZoom;
                  setZoom(newZoom);
                  return;
                }
                if (!isDragging) return;
                const dx = e.clientX - dragStartRef.current.x;
                const dy = e.clientY - dragStartRef.current.y;
                setTranslate({ x: dragStartRef.current.tx + dx, y: dragStartRef.current.ty + dy });
              }}
              onPointerUp={(e) => {
                activePointers.current.delete(e.pointerId);
                pinchRef.current = null;
                setIsDragging(false);
              }}
              onPointerLeave={(e) => {
                activePointers.current.delete(e.pointerId);
                pinchRef.current = null;
                setIsDragging(false);
              }}
              onWheel={(e) => {
                e.preventDefault();
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                const newZoom = Math.min(5, Math.max(0.1, zoom * factor));
                currentZoomRef.current = newZoom;
                setZoom(newZoom);
              }}
              onClick={() => setHighlightId(null)}
            >
              <g transform={`translate(${translate.x},${translate.y}) scale(${zoom})`}>
                <g transform="scale(0.8, 1)">
                {linkPaths.map((l, i) => (
                  <path
                    key={i}
                    d={l.path}
                    fill="none"
                    stroke="#92795a"
                    strokeWidth={l.strokeWidth}
                    strokeLinecap="round"
                    opacity={0.85}
                  />
                ))}
                {Array.from(organicLayout.entries()).map(([id, pos]) => {
                  const node = allPositionedNodes.get(id);
                  if (!node) return null;
                  return (
                    <g key={id} transform={`translate(${pos.x},${pos.y})`}>
                      {renderNode({ nodeDatum: node.datum } as CustomNodeElementProps)}
                    </g>
                  );
                })}
                </g>
              </g>
            </svg>

            {/* أزرار التحكم + لوحة التعديل */}
            <div className="absolute bottom-4 left-4 z-30 flex flex-col items-start gap-1">
              <div className="flex flex-col gap-1 bg-white rounded-lg shadow-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    const nz = Math.min(5, zoom * 1.2);
                    currentZoomRef.current = nz;
                    setZoom(nz);
                  }}
                  className="w-9 h-9 flex items-center justify-center text-slate-700 hover:bg-slate-100 text-lg font-bold border-b border-slate-200"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nz = Math.max(0.1, zoom * 0.8);
                    currentZoomRef.current = nz;
                    setZoom(nz);
                  }}
                  className="w-9 h-9 flex items-center justify-center text-slate-700 hover:bg-slate-100 text-lg font-bold border-b border-slate-200"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const fit = computeFitZoom(organicLayout, dimensions.width, dimensions.height);
                    currentZoomRef.current = fit.zoom;
                    setZoom(fit.zoom);
                    setTranslate(fit.translate);
                  }}
                  className="w-9 h-9 flex items-center justify-center text-slate-700 hover:bg-slate-100 text-xs border-b border-slate-200"
                  title="احتواء الشجرة كاملة"
                >
                  ⤢
                </button>
                <button
                  type="button"
                  onClick={() => setShowTuner((v) => !v)}
                  className="w-9 h-9 flex items-center justify-center text-slate-700 hover:bg-slate-100 text-xs"
                  title="ضبط شكل الشجرة"
                >
                  ⚙
                </button>
              </div>

              {/* لوحة التحكم (Tuner) – نطاق واسع جداً (0-1000) */}
              {showTuner && (
                <div className="bg-white rounded-lg shadow-lg border border-slate-200 p-3 w-56 text-xs mt-1">
                  <div className="flex justify-between mb-1">
                    <span className="text-slate-600">تفاوت ارتفاع الأفرع</span>
                    <span className="text-slate-400">{branchOffset}px</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBranchOffset((v) => Math.max(0, v - 10))}
                      className="w-6 h-6 flex items-center justify-center bg-slate-100 hover:bg-slate-200 rounded"
                    >
                      −
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      step={5}
                      value={branchOffset}
                      onChange={(e) => setBranchOffset(parseInt(e.target.value))}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setBranchOffset((v) => Math.min(1000, v + 10))}
                      className="w-6 h-6 flex items-center justify-center bg-slate-100 hover:bg-slate-200 rounded"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* الشريط الجانبي للأخوات والخالات */}
        {selectedPerson && (
          <div className="absolute top-4 left-4 z-30 bg-white rounded-xl shadow-lg border border-slate-200 p-3 max-w-[240px] min-w-[200px] max-h-[70vh] overflow-y-auto">
            <div className="mb-3">
              <div className="text-xs font-bold text-slate-600 mb-2 flex items-center gap-2">
                <Users className="w-3.5 h-3.5" />
                أخوات {personName(selectedPerson.person)}
              </div>
              {sistersInfo.length === 0 ? (
                <div className="text-xs text-slate-400 italic pr-2">لا توجد أخوات</div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {sistersInfo.map(({ sister, color, children }) => (
                      <button
                        key={sister.id}
                        onClick={() => {
                          if (showAllSisters) setShowAllSisters(false);
                          if (selectedSisterId === sister.id) {
                            setSelectedSisterId(null);
                          } else {
                            setSelectedSisterId(sister.id);
                            setSelectedAuntId(null);
                            setShowAllAunts(false);
                          }
                        }}
                        className={`w-full text-right px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 text-xs ${
                          selectedSisterId === sister.id && !showAllSisters
                            ? 'bg-slate-100 ring-2 ring-slate-300'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <div
                          className="w-3 h-3 rounded-full border border-slate-200 shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-slate-700 font-medium truncate">
                          {personName(sister)}
                        </span>
                        <span className="text-slate-400 text-[10px] mr-auto">
                          ({children.length})
                        </span>
                        {selectedSisterId === sister.id && !showAllSisters && (
                          <span className="text-[10px] text-emerald-600 font-bold">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      if (showAllSisters) {
                        setShowAllSisters(false);
                        setSelectedSisterId(null);
                      } else {
                        setShowAllSisters(true);
                        setSelectedSisterId(null);
                        setSelectedAuntId(null);
                        setShowAllAunts(false);
                      }
                    }}
                    className={`w-full mt-2 text-center text-xs font-medium py-1.5 rounded-lg transition-colors ${
                      showAllSisters
                        ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {showAllSisters ? 'إلغاء الكل' : 'إظهار الكل'}
                  </button>
                </>
              )}
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="text-xs font-bold text-slate-600 mb-2 flex items-center gap-2">
                <Users className="w-3.5 h-3.5" />
                خالات {personName(selectedPerson.person)}
              </div>
              {auntsInfo.length === 0 ? (
                <div className="text-xs text-slate-400 italic pr-2">لا توجد خالات</div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {auntsInfo.map(({ sister, color, children }) => (
                      <button
                        key={sister.id}
                        onClick={() => {
                          if (showAllAunts) setShowAllAunts(false);
                          if (selectedAuntId === sister.id) {
                            setSelectedAuntId(null);
                          } else {
                            setSelectedAuntId(sister.id);
                            setSelectedSisterId(null);
                            setShowAllSisters(false);
                          }
                        }}
                        className={`w-full text-right px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 text-xs ${
                          selectedAuntId === sister.id && !showAllAunts
                            ? 'bg-slate-100 ring-2 ring-slate-300'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <div
                          className="w-3 h-3 rounded-full border border-slate-200 shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-slate-700 font-medium truncate">
                          {personName(sister)}
                        </span>
                        <span className="text-slate-400 text-[10px] mr-auto">
                          ({children.length})
                        </span>
                        {selectedAuntId === sister.id && !showAllAunts && (
                          <span className="text-[10px] text-emerald-600 font-bold">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      if (showAllAunts) {
                        setShowAllAunts(false);
                        setSelectedAuntId(null);
                      } else {
                        setShowAllAunts(true);
                        setSelectedAuntId(null);
                        setSelectedSisterId(null);
                        setShowAllSisters(false);
                      }
                    }}
                    className={`w-full mt-2 text-center text-xs font-medium py-1.5 rounded-lg transition-colors ${
                      showAllAunts
                        ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {showAllAunts ? 'إلغاء الكل' : 'إظهار الكل'}
                  </button>
                </>
              )}
            </div>

            <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-400 flex justify-between items-center">
              <span>اختر لتلوين الأبناء</span>
              {(selectedSisterId || selectedAuntId || showAllSisters || showAllAunts) && (
                <button
                  onClick={() => {
                    setSelectedSisterId(null);
                    setSelectedAuntId(null);
                    setShowAllSisters(false);
                    setShowAllAunts(false);
                  }}
                  className="text-red-500 hover:text-red-700 text-[10px] font-medium"
                >
                  إلغاء التلوين
                </button>
              )}
            </div>
          </div>
        )}

        {/* البطاقة الشخصية */}
        {selectedPerson && (
          <div
            className="absolute bottom-4 right-4 z-30 w-[320px] max-w-[calc(100%-32px)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-start justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {selectedPerson.person.photo_url ? (
                    <img
                      src={selectedPerson.person.photo_url}
                      alt={personName(selectedPerson.person)}
                      className="w-12 h-12 rounded-full object-cover border border-slate-200"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                      <UserRound className="w-6 h-6" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <h2 className="font-bold text-slate-800 truncate text-lg">
                      {personName(selectedPerson.person)}
                    </h2>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <p className="text-xs text-slate-500">
                        {isFemale(selectedPerson.person) ? 'أنثى' : 'ذكر'}
                        {selectedPerson.person.family_title ? ` • ${selectedPerson.person.family_title}` : ''}
                      </p>
                      {selectedPerson.person.life_status && (
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            selectedPerson.person.life_status === 'حي'
                              ? 'bg-green-100 text-green-700'
                              : selectedPerson.person.life_status === 'متوفى'
                              ? 'bg-slate-200 text-slate-600'
                              : selectedPerson.person.life_status === 'شهيد'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {selectedPerson.person.life_status}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPerson(null);
                    setSelectedSisterId(null);
                    setSelectedAuntId(null);
                    setShowAllSisters(false);
                    setShowAllAunts(false);
                    setSelectedHighlightId(null);
                    setHighlightId(null);
                  }}
                  className="text-slate-400 hover:text-slate-700 shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="px-4 py-3">
                <div className="grid grid-cols-3 gap-2 text-center mb-3">
                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">الأبناء</div>
                    <div className="font-bold text-slate-700">
                      {getChildren(selectedPerson.person.id).length}
                    </div>
                  </div>
                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">الأزواج</div>
                    <div className="font-bold text-slate-700">
                      {getSpousesWithMarriage(selectedPerson.person.id).length}
                    </div>
                  </div>
                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">الإخوة</div>
                    <div className="font-bold text-slate-700">
                      {getSiblings(selectedPerson.person).length}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => openRelations(selectedPerson.person)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
                >
                  <GitBranch className="w-4 h-4" />
                  استعراض العلاقات
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setRadialRoot(buildRadialTree(selectedPerson.person, getChildren));
                    setRadialOpen(true);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 mt-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium"
                >
                  عرض شعاعي لهذا الفرع
                </button>
              </div>
            </div>
          </div>
        )}

        {!selectedPerson && !relationOpen && (
          <div className="absolute bottom-4 left-4 z-10 bg-white/90 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-3 py-2 text-xs text-slate-500 pointer-events-none">
            اضغط على الشخص لاستعراض علاقاته
          </div>
        )}
      </div>

      {relationOpen && <RelationDiagram />}

      {radialOpen && radialRoot && (
        <RadialBranchView root={radialRoot} onClose={() => setRadialOpen(false)} />
      )}
    </div>
  );
}