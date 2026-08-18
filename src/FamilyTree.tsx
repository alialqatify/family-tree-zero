import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Tree, {
  RawNodeDatum,
  CustomNodeElementProps,
} from 'react-d3-tree';
import {
  hierarchy,
  tree as d3tree,
} from 'd3-hierarchy';
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

/* =========================================================
   Constants
========================================================= */

const NODE_SIZE = { x: 220, y: 140 };

const SEPARATION = {
  siblings: 1.5,
  nonSiblings: 2,
};

const DEPTH_FACTOR = -180;

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

/* ------------------------------------------
   دوال خاصة بالأم والأخوات والخالات
------------------------------------------ */

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
   Main tree helpers
========================================================= */

function findPath(
  roots: TreeNode[],
  targetId: string,
): string[] | null {
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
  collapsedIds: Set<string>,
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

function computeNodePosition(
  rootData: TreeNode,
  targetId: string,
): { x: number; y: number } | null {
  const layout = d3tree<TreeNode>()
    .nodeSize([NODE_SIZE.x, NODE_SIZE.y])
    .separation((a, b) =>
      a.parent === b.parent ? SEPARATION.siblings : SEPARATION.nonSiblings
    );

  const root = hierarchy<TreeNode>(rootData, (d) => d.children);
  layout(root);

  root.descendants().forEach((node) => {
    node.y = node.depth * DEPTH_FACTOR;
  });

  const target = root.descendants().find(
    (node) => node.data.attributes?.id === targetId
  );
  if (!target || target.x == null || target.y == null) return null;
  return { x: target.x, y: target.y };
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

  const containerRef = useRef<HTMLDivElement>(null);
  const currentZoomRef = useRef(1);

  /* =======================================================
     Load all data
  ======================================================= */

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setLoadState('loading');
      setErrorMsg('');

      const [peopleResult, marriagesResult, childrenResult] = await Promise.all([
        supabase.from('people').select(`
            id,
            display_id,
            full_name,
            family_title,
            gender,
            father_id,
            is_external,
            life_status,
            phone_number,
            photo_url,
            family_origin_id
          `),
        supabase.from('marriages').select(`
            marriage_id,
            husband_id,
            wife_id,
            status
          `),
        supabase.from('children_link').select(`
            child_id,
            marriage_id
          `),
      ]);

      if (cancelled) return;

      if (peopleResult.error) {
        setErrorMsg(`فشل تحميل الأشخاص: ${peopleResult.error.message}`);
        setLoadState('error');
        return;
      }
      if (marriagesResult.error) {
        setErrorMsg(`فشل تحميل الزيجات: ${marriagesResult.error.message}`);
        setLoadState('error');
        return;
      }
      if (childrenResult.error) {
        setErrorMsg(`فشل تحميل علاقات الأبناء: ${childrenResult.error.message}`);
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

  /* =======================================================
     Dimensions
  ======================================================= */

  useEffect(() => {
    if (!containerRef.current) return;
    const updateDims = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDimensions({ width: rect.width, height: rect.height });
      if (treeKey === 'tree-initial') {
        setTranslate({ x: rect.width / 2, y: rect.height - 80 });
      }
    };
    updateDims();
    window.addEventListener('resize', updateDims);
    return () => window.removeEventListener('resize', updateDims);
  }, [loadState, treeKey]);

  /* =======================================================
     ESC handlers
  ======================================================= */

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
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

  /* =======================================================
     Maps
  ======================================================= */

  const personMap = useMemo(() => {
    const map = new Map<string, Person>();
    for (const person of people) {
      map.set(person.id, person);
    }
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

  /* =======================================================
     Relationship helpers
  ======================================================= */

  const getSpousesWithMarriage = useCallback(
    (personId: string): SpouseWithMarriage[] => {
      const result: SpouseWithMarriage[] = [];
      const list = marriagesByPerson.get(personId) || [];
      for (const marriage of list) {
        let spouseId: string | null = null;
        if (marriage.husband_id === personId) {
          spouseId = marriage.wife_id;
        } else if (marriage.wife_id === personId) {
          spouseId = marriage.husband_id;
        }
        if (!spouseId) continue;
        const spouse = personMap.get(spouseId);
        if (spouse) {
          result.push({ person: spouse, marriageId: marriage.marriage_id });
        }
      }
      const seen = new Set<string>();
      const unique: SpouseWithMarriage[] = [];
      for (const item of result) {
        if (!seen.has(item.person.id)) {
          seen.add(item.person.id);
          unique.push(item);
        }
      }
      return unique;
    },
    [marriagesByPerson, personMap]
  );

  const getChildren = useCallback(
    (personId: string): Person[] => {
      const result: Person[] = [];
      for (const person of people) {
        if (person.father_id === personId) {
          result.push(person);
        }
      }
      const marriagesOfPerson = marriagesByPerson.get(personId) || [];
      for (const marriage of marriagesOfPerson) {
        const children = childrenByMarriage.get(marriage.marriage_id) || [];
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
      return {
        person,
        spouses: spousesWithMarriage,
        childrenBySpouse,
      };
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

  /* =======================================================
     Main tree helpers
  ======================================================= */

  const nodesWithChildren = useMemo(() => {
    const result = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          result.add(node.attributes.id);
        }
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

  /* =======================================================
     حساب عدد الذرية من الشجرة الكاملة (مرة واحدة)
  ======================================================= */

  const descendantCountMap = useMemo(() => {
    const map = new Map<string, number>();

    const countAndFill = (node: TreeNode): number => {
      let count = node.children.length;
      for (const child of node.children) {
        count += countAndFill(child);
      }
      map.set(node.attributes.id, count);
      return count;
    };

    for (const root of treeData) {
      countAndFill(root);
    }

    return map;
  }, [treeData]);

  /* =======================================================
     حساب الخطوط المخصصة (تستخدم descendantCountMap)
  ======================================================= */

  const customLinks = useMemo(() => {
    if (!visibleData.length) return [];

    const links: { path: string; strokeWidth: number }[] = [];

    for (const rootData of visibleData) {
      const layout = d3tree<TreeNode>()
        .nodeSize([NODE_SIZE.x, NODE_SIZE.y])
        .separation((a, b) =>
          a.parent === b.parent ? SEPARATION.siblings : SEPARATION.nonSiblings,
        );

      const root = hierarchy<TreeNode>(rootData, (d) => d.children);
      layout(root);
      root.descendants().forEach((n) => { n.y = n.depth * DEPTH_FACTOR; });

      for (const link of root.links()) {
        const descendants = descendantCountMap.get(link.target.data.attributes.id) ?? 0;
        const strokeWidth = Math.min(14, Math.max(2, 2 + Math.sqrt(descendants) * 1.3));
        const sx = link.source.x!, sy = link.source.y!;
        const tx = link.target.x!, ty = link.target.y!;
        const midY = (sy + ty) / 2;

        links.push({
          path: `M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`,
          strokeWidth,
        });
      }
    }

    return links;
  }, [visibleData, descendantCountMap]);

  /* =======================================================
     Search
  ======================================================= */

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
      for (const id of path) {
        newCollapsedIds.delete(id);
      }
      const expandedData = buildVisibleData(treeData, newCollapsedIds);
      const firstRoot = expandedData[0];
      const targetPos = firstRoot
        ? computeNodePosition(firstRoot, personId)
        : null;
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
    [treeData, collapsedIds, dimensions]
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

  /* =======================================================
     Collapse
  ======================================================= */

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* =======================================================
     Main tree update - Fixed: receives zoom AND translate
  ======================================================= */

  const handleUpdate = useCallback(
    (state: { zoom: number; translate: { x: number; y: number } }) => {
      currentZoomRef.current = state.zoom;
      setZoom(state.zoom);
      setTranslate(state.translate);
    },
    [],
  );

  /* =======================================================
     تحديث معلومات الأخوات والخالات عند اختيار شخص
  ======================================================= */

  useEffect(() => {
    if (selectedPerson) {
      const sisters = getSisters(
        selectedPerson.person,
        people,
        marriages,
        childrenLinks,
        personMap
      );
      setSistersInfo(sisters);

      const aunts = getSistersOfMother(
        selectedPerson.person,
        people,
        marriages,
        childrenLinks,
        personMap
      );
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

  /* =======================================================
     Main tree custom node (LEAF SHAPE with className)
  ======================================================= */

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
            if (
              isPersonInFamily(
                id,
                info.sister.id,
                people,
                marriages,
                childrenLinks,
                personMap
              )
            ) {
              sisterColor = info.color;
              break;
            }
          }
        } else if (selectedSisterId) {
          const found = sistersInfo.find(
            (info) => info.sister.id === selectedSisterId
          );
          if (found) {
            if (
              isPersonInFamily(
                id,
                selectedSisterId,
                people,
                marriages,
                childrenLinks,
                personMap
              )
            ) {
              sisterColor = found.color;
            }
          }
        }
      }

      let auntColor: string | null = null;
      if (selectedPerson) {
        if (showAllAunts) {
          for (const info of auntsInfo) {
            if (
              isPersonInFamily(
                id,
                info.sister.id,
                people,
                marriages,
                childrenLinks,
                personMap
              )
            ) {
              auntColor = info.color;
              break;
            }
          }
        } else if (selectedAuntId) {
          const found = auntsInfo.find(
            (info) => info.sister.id === selectedAuntId
          );
          if (found) {
            if (
              isPersonInFamily(
                id,
                selectedAuntId,
                people,
                marriages,
                childrenLinks,
                personMap
              )
            ) {
              auntColor = found.color;
            }
          }
        }
      }

      const finalColor = auntColor || sisterColor;

      const handlePointerDown = (event: React.PointerEvent) => {
        event.currentTarget.setAttribute('data-dx', String(event.clientX));
        event.currentTarget.setAttribute('data-dy', String(event.clientY));
      };

      const handlePointerUp = (event: React.PointerEvent) => {
        const dx = parseFloat(
          event.currentTarget.getAttribute('data-dx') || '0'
        );
        const dy = parseFloat(
          event.currentTarget.getAttribute('data-dy') || '0'
        );
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

      // Leaf shape path
      const leafW = rectWidth * 1.3;
      const leafH = rectHeight * 1.7;
      const leafPath = `M${-leafW / 2},0 Q0,${-leafH / 2} ${leafW / 2},0 Q0,${leafH / 2} ${-leafW / 2},0 Z`;

      return (
        <g
          data-person-id={id}
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

          {/* Leaf-shaped background with special className */}
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
            strokeWidth={
              isHighlighted || isSelected ? 2 : finalColor ? 2 : 1.3
            }
          />

          <text
            x="0"
            y={title ? -7 : 5}
            textAnchor="middle"
            fill="#1e3a8a"
            fontSize="16"
            fontWeight="600"
            style={{ fontFamily: 'Cairo, sans-serif' }}
          >
            {nodeDatum.name}
            {isDead && (
              <tspan fill="#64748b" fontSize="12" dx="4" fontWeight="400">
                (رحمه الله)
              </tspan>
            )}
          </text>

          {title && (
            <text
              x="0"
              y="15"
              textAnchor="middle"
              fill="#64748b"
              fontSize="12"
              style={{ fontFamily: 'Cairo, sans-serif' }}
            >
              {title}
            </text>
          )}

          {hasChildren && (
            <g
              data-arrow="true"
              transform={`translate(${rectWidth / 2 + 10}, 0)`}
            >
              <circle r={10} fill="#1e40af" data-arrow="true" />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fill="#ffffff"
                fontSize="11"
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

  /* =======================================================
     Open relationship view
  ======================================================= */

  const openRelations = useCallback((person: Person) => {
    setSelectedPerson(null);
    setRelationPerson(person);
    setRelationOpen(true);
  }, []);

  /* =======================================================
     Relation person node
  ======================================================= */

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
          compact
            ? 'min-w-[110px] px-3 py-2'
            : 'min-w-[145px] px-4 py-3',
          dead ? 'border-slate-300' : 'border-slate-200',
        ].join(' ')}
      >
        <span className="text-sm font-bold text-slate-800">
          {personName(person)}
        </span>
        {role && <span className="mt-1 text-[11px] text-slate-500">{role}</span>}
        {person.family_title && (
          <span className="mt-0.5 text-[10px] text-slate-400">
            {person.family_title}
          </span>
        )}
        {dead && (
          <span className="mt-1 text-[10px] text-slate-400">
            {person.life_status}
          </span>
        )}
      </button>
    );
  };

  /* =======================================================
     Family branch
  ======================================================= */

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

  /* =======================================================
     Relation diagram
  ======================================================= */

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
          onClick={(event) => event.stopPropagation()}
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
                    <span className="text-sm font-bold text-slate-700">
                      الإخوة والأخوات وعائلاتهم
                    </span>
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

  /* =========================================================
     RADIAL BRANCH VIEW COMPONENT
  ========================================================== */

  interface RadialNode {
    id: string;
    name: string;
    children: RadialNode[];
  }

  function buildRadialTree(
    rootPerson: Person,
    getChildrenFn: (id: string) => Person[],
    maxDepth = 6,
    maxNodes = 200,
  ): RadialNode {
    let count = 0;

    const build = (person: Person, depth: number): RadialNode => {
      count++;
      const node: RadialNode = {
        id: person.id,
        name: personName(person),
        children: [],
      };

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
        .separation((a, b) =>
          (a.parent === b.parent ? 1 : 1.6) / Math.max(a.depth, 1),
        );

      layout(h);

      return {
        nodes: h.descendants(),
        links: h.links(),
        maxDepth: depth,
      };
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

          <div className="p-4 overflow-auto">
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
                  const onRightHalf =
                    Math.cos(node.x - Math.PI / 2) >= 0;

                  return (
                    <g
                      key={node.data.id}
                      transform={`translate(${p.x},${p.y})`}
                    >
                      <circle
                        r={5}
                        fill={node.depth === 0 ? '#1e40af' : '#64748b'}
                      />
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

  /* =======================================================
     Loading, Error, Empty
  ======================================================= */

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
        <a href="#/" className="text-sm text-blue-600 underline mt-2">
          العودة للوحة التحكم
        </a>
      </div>
    );
  }

  if (loadState === 'empty') {
    return (
      <div dir="rtl" className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4">
        <AlertCircle className="w-8 h-8 text-amber-500" />
        <p className="text-sm text-slate-600 text-center max-w-md">
          لا توجد بيانات ذكور في قاعدة البيانات لعرض الشجرة.
        </p>
        <a href="#/" className="text-sm text-blue-600 underline mt-2">
          العودة للوحة التحكم
        </a>
      </div>
    );
  }

  /* =======================================================
     Main UI
  ======================================================= */

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
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setSearchMessage('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleSearch();
                }
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

      {/* Tree */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        onClick={() => {
          setHighlightId(null);
        }}
      >
        {dimensions.width > 0 && visibleData.length > 0 && (
          <>
            {/* طبقة الخطوط المخصصة (تحت) - z-index 10 */}
            <svg
              className="absolute inset-0 pointer-events-none"
              style={{ zIndex: 10 }}
              width={dimensions.width}
              height={dimensions.height}
            >
              <g transform={`translate(${translate.x},${translate.y}) scale(${zoom})`}>
                {customLinks.map((l, i) => (
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
              </g>
            </svg>

            {/* إخفاء خطوط المكتبة الافتراضية فقط (تستثني .leaf-node-shape) */}
            <style>{`
              .rd3t-tree-container svg path:not(.leaf-node-shape) {
                stroke: transparent !important;
                stroke-width: 0 !important;
                opacity: 0 !important;
              }
            `}</style>

            {/* شجرة المكتبة (فوق) - z-index 20 */}
            <div className="absolute inset-0" style={{ zIndex: 20 }}>
              <Tree
                key={treeKey}
                data={visibleData}
                orientation="vertical"
                pathFunc="diagonal"
                collapsible={false}
                depthFactor={DEPTH_FACTOR}
                nodeSize={NODE_SIZE}
                separation={SEPARATION}
                dimensions={dimensions}
                zoomable
                scaleExtent={{ min: 0.1, max: 5 }}
                translate={translate}
                zoom={zoom}
                renderCustomNodeElement={renderNode}
                transitionDuration={300}
                onUpdate={handleUpdate}
              />
            </div>
          </>
        )}

        {/* الشريط الجانبي للأخوات والخالات */}
        {selectedPerson && (
          <div className="absolute top-4 left-4 z-30 bg-white rounded-xl shadow-lg border border-slate-200 p-3 max-w-[240px] min-w-[200px] max-h-[70vh] overflow-y-auto">
            {/* قسم الأخوات */}
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
                          if (showAllSisters) {
                            setShowAllSisters(false);
                          }
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

            {/* قسم الخالات */}
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
                          if (showAllAunts) {
                            setShowAllAunts(false);
                          }
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
            onClick={(event) => event.stopPropagation()}
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
                    {selectedPerson.person.display_id && (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[10px] text-slate-400 font-mono bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
                          #{selectedPerson.person.display_id}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (selectedPerson.person.display_id) {
                              navigator.clipboard?.writeText(selectedPerson.person.display_id).catch(() => {});
                            }
                          }}
                          className="text-slate-400 hover:text-slate-600 transition-colors"
                          title="نسخ المعرف"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                          </svg>
                        </button>
                      </div>
                    )}
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
                    setRadialRoot(
                      buildRadialTree(selectedPerson.person, getChildren),
                    );
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
        <RadialBranchView
          root={radialRoot}
          onClose={() => setRadialOpen(false)}
        />
      )}
    </div>
  );
}