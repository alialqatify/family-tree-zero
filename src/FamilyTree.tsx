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
  ChevronLeft,
  ChevronRight,
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
  childrenBySpouse: Map<string, Person[]>; // key: marriageId
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

/* =========================================================
   Main tree helpers
========================================================= */

function findPath(
  roots: TreeNode[],
  targetId: string,
): string[] | null {
  const dfs = (
    node: TreeNode,
    path: string[],
  ): string[] | null => {
    if (node.attributes.id === targetId) {
      return [...path, node.attributes.id];
    }

    for (const child of node.children) {
      const result = dfs(
        child,
        [...path, node.attributes.id],
      );

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
      a.parent === b.parent
        ? SEPARATION.siblings
        : SEPARATION.nonSiblings,
    );

  const root = hierarchy<TreeNode>(
    rootData,
    (d) => d.children,
  );

  layout(root);

  root.descendants().forEach((node) => {
    node.y = node.depth * DEPTH_FACTOR;
  });

  const target = root
    .descendants()
    .find(
      (node) =>
        node.data.attributes?.id === targetId,
    );

  if (
    !target ||
    target.x == null ||
    target.y == null
  ) {
    return null;
  }

  return {
    x: target.x,
    y: target.y,
  };
}

/* =========================================================
   Component
========================================================= */

export default function FamilyTree() {
  const [loadState, setLoadState] =
    useState<LoadState>('loading');

  const [errorMsg, setErrorMsg] =
    useState('');

  const [people, setPeople] =
    useState<Person[]>([]);

  const [marriages, setMarriages] =
    useState<Marriage[]>([]);

  const [childrenLinks, setChildrenLinks] =
    useState<ChildLink[]>([]);

  const [treeData, setTreeData] =
    useState<TreeNode[]>([]);

  const [collapsedIds, setCollapsedIds] =
    useState<Set<string>>(new Set());

  const [searchTerm, setSearchTerm] =
    useState('');

  const [searchMessage, setSearchMessage] =
    useState('');

  const [highlightId, setHighlightId] =
    useState<string | null>(null);

  const [selectedPerson, setSelectedPerson] =
    useState<ModalPerson | null>(null);

  const [relationPerson, setRelationPerson] =
    useState<Person | null>(null);

  const [dimensions, setDimensions] =
    useState({
      width: 0,
      height: 0,
    });

  const [translate, setTranslate] =
    useState({
      x: 0,
      y: 0,
    });

  const [zoom, setZoom] =
    useState(1);

  const [treeKey, setTreeKey] =
    useState('tree-initial');

  const [relationOpen, setRelationOpen] =
    useState(false);

  const containerRef =
    useRef<HTMLDivElement>(null);

  const currentZoomRef =
    useRef(1);

  /* =======================================================
     Load all data
  ======================================================= */

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setLoadState('loading');
      setErrorMsg('');

      const [
        peopleResult,
        marriagesResult,
        childrenResult,
      ] = await Promise.all([
        supabase
          .from('people')
          .select(`
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

        supabase
          .from('marriages')
          .select(`
            marriage_id,
            husband_id,
            wife_id,
            status
          `),

        supabase
          .from('children_link')
          .select(`
            child_id,
            marriage_id
          `),
      ]);

      if (cancelled) return;

      if (peopleResult.error) {
        setErrorMsg(
          `فشل تحميل الأشخاص: ${peopleResult.error.message}`,
        );
        setLoadState('error');
        return;
      }

      if (marriagesResult.error) {
        setErrorMsg(
          `فشل تحميل الزيجات: ${marriagesResult.error.message}`,
        );
        setLoadState('error');
        return;
      }

      if (childrenResult.error) {
        setErrorMsg(
          `فشل تحميل علاقات الأبناء: ${childrenResult.error.message}`,
        );
        setLoadState('error');
        return;
      }

      const loadedPeople =
        (peopleResult.data || []) as Person[];

      const loadedMarriages =
        (marriagesResult.data || []) as Marriage[];

      const loadedChildren =
        (childrenResult.data || []) as ChildLink[];

      if (loadedPeople.length === 0) {
        setLoadState('empty');
        return;
      }

      setPeople(loadedPeople);
      setMarriages(loadedMarriages);
      setChildrenLinks(loadedChildren);

      /*
       * Main tree:
       * blood-line males only.
       * External (in-law) men and their
       * descendants are excluded — they
       * belong to a different family's tree.
       */
      const externalIds = new Set(
        loadedPeople
          .filter((p) => p.is_external)
          .map((p) => p.id),
      );

      const malePeople = loadedPeople.filter(
        (p) => isMale(p) && !p.is_external,
      );

      const nodeMap =
        new Map<string, TreeNode>();

      for (const person of malePeople) {
        nodeMap.set(person.id, {
          name:
            person.full_name?.trim() || '—',

          attributes: {
            id: person.id,
            title:
              person.family_title || '',
            status:
              person.life_status || '',
          },

          children: [],
        });
      }

      const roots: TreeNode[] = [];

      for (const person of malePeople) {
        const node =
          nodeMap.get(person.id);

        if (!node) continue;

        if (
          person.father_id &&
          nodeMap.has(person.father_id)
        ) {
          nodeMap
            .get(person.father_id)!
            .children
            .push(node);
        } else if (
          person.father_id &&
          externalIds.has(person.father_id)
        ) {
          // Son of an external (in-law) man —
          // not part of this patriline, skip
          // entirely instead of creating a
          // ghost root.
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

      const rect =
        containerRef.current.getBoundingClientRect();

      setDimensions({
        width: rect.width,
        height: rect.height,
      });

      if (treeKey === 'tree-initial') {
        setTranslate({
          x: rect.width / 2,
          y: rect.height - 80,
        });
      }
    };

    updateDims();

    window.addEventListener(
      'resize',
      updateDims,
    );

    return () => {
      window.removeEventListener(
        'resize',
        updateDims,
      );
    };
  }, [loadState, treeKey]);

  /* =======================================================
     ESC handlers
  ======================================================= */

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      setSelectedPerson(null);
      setRelationOpen(false);
    };

    window.addEventListener(
      'keydown',
      handler,
    );

    return () => {
      window.removeEventListener(
        'keydown',
        handler,
      );
    };
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
    const map =
      new Map<string, Marriage[]>();

    for (const marriage of marriages) {
      if (marriage.husband_id) {
        const list =
          map.get(marriage.husband_id) || [];

        list.push(marriage);

        map.set(
          marriage.husband_id,
          list,
        );
      }

      if (marriage.wife_id) {
        const list =
          map.get(marriage.wife_id) || [];

        list.push(marriage);

        map.set(
          marriage.wife_id,
          list,
        );
      }
    }

    return map;
  }, [marriages]);

  const childrenByMarriage = useMemo(() => {
    const map =
      new Map<string, Person[]>();

    for (const link of childrenLinks) {
      const child =
        personMap.get(link.child_id);

      if (!child) continue;

      const list =
        map.get(link.marriage_id) || [];

      list.push(child);

      map.set(
        link.marriage_id,
        list,
      );
    }

    return map;
  }, [childrenLinks, personMap]);

  /* =======================================================
     Relationship helpers
  ======================================================= */

  const getSpousesWithMarriage =
    useCallback(
      (personId: string): SpouseWithMarriage[] => {
        const result: SpouseWithMarriage[] = [];

        const list =
          marriagesByPerson.get(personId) || [];

        for (const marriage of list) {
          let spouseId: string | null = null;

          if (
            marriage.husband_id === personId
          ) {
            spouseId =
              marriage.wife_id;
          } else if (
            marriage.wife_id === personId
          ) {
            spouseId =
              marriage.husband_id;
          }

          if (!spouseId) continue;

          const spouse =
            personMap.get(spouseId);

          if (spouse) {
            result.push({
              person: spouse,
              marriageId:
                marriage.marriage_id,
            });
          }
        }

        // Remove duplicates (a person may have multiple marriages with same spouse? unlikely, but safe)
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
      [
        marriagesByPerson,
        personMap,
      ],
    );

  const getChildren =
    useCallback(
      (personId: string): Person[] => {
        const result: Person[] = [];

        /*
         * Primary relationship:
         * father_id.
         */
        for (const person of people) {
          if (
            person.father_id === personId
          ) {
            result.push(person);
          }
        }

        /*
         * Marriage relationship:
         * children_link.
         */
        const marriagesOfPerson =
          marriagesByPerson.get(
            personId,
          ) || [];

        for (const marriage of marriagesOfPerson) {
          const children =
            childrenByMarriage.get(
              marriage.marriage_id,
            ) || [];

          result.push(...children);
        }

        return uniquePeople(result);
      },
      [
        people,
        marriagesByPerson,
        childrenByMarriage,
      ],
    );

  const getParent =
    useCallback(
      (person: Person): Person | null => {
        if (!person.father_id) {
          return null;
        }

        return (
          personMap.get(
            person.father_id,
          ) || null
        );
      },
      [personMap],
    );

  const getSiblings =
    useCallback(
      (person: Person): Person[] => {
        if (!person.father_id) {
          return [];
        }

        return people.filter(
          (candidate) =>
            candidate.id !== person.id &&
            candidate.father_id ===
              person.father_id,
        );
      },
      [people],
    );

  const buildFamily =
    useCallback(
      (
        person: Person,
      ): RelationFamily => {
        const spousesWithMarriage =
          getSpousesWithMarriage(
            person.id,
          );

        const childrenBySpouse =
          new Map<string, Person[]>();

        for (const {
          marriageId,
        } of spousesWithMarriage) {
          const children =
            childrenByMarriage.get(
              marriageId,
            ) || [];

          childrenBySpouse.set(
            marriageId,
            children,
          );
        }

        return {
          person,
          spouses: spousesWithMarriage,
          childrenBySpouse,
        };
      },
      [
        getSpousesWithMarriage,
        childrenByMarriage,
      ],
    );

  const buildRelationView =
    useCallback(
      (
        person: Person,
      ): RelationView => {
        const siblings =
          getSiblings(person);

        const siblingFamilies =
          siblings.map(
            (sibling) =>
              buildFamily(sibling),
          );

        return {
          person,
          parent:
            getParent(person),
          siblings,
          ownFamily:
            buildFamily(person),
          siblingFamilies,
        };
      },
      [
        getSiblings,
        getParent,
        buildFamily,
      ],
    );

  /* =======================================================
     Current relation view
  ======================================================= */

  const relationView =
    useMemo(() => {
      if (!relationPerson) {
        return null;
      }

      return buildRelationView(
        relationPerson,
      );
    }, [
      relationPerson,
      buildRelationView,
    ]);

  /* =======================================================
     Main tree helpers
  ======================================================= */

  const allMaleNodes = useMemo(() => {
    const flat: {
      id: string;
      name: string;
    }[] = [];

    const walk = (
      nodes: TreeNode[],
    ) => {
      for (const node of nodes) {
        flat.push({
          id:
            node.attributes.id,
          name:
            node.name,
        });

        if (
          node.children.length
        ) {
          walk(node.children);
        }
      }
    };

    walk(treeData);

    return flat;
  }, [treeData]);

  const nodesWithChildren =
    useMemo(() => {
      const result =
        new Set<string>();

      const walk = (
        nodes: TreeNode[],
      ) => {
        for (const node of nodes) {
          if (
            node.children.length > 0
          ) {
            result.add(
              node.attributes.id,
            );
          }

          walk(node.children);
        }
      };

      walk(treeData);

      return result;
    }, [treeData]);

  const visibleData = useMemo(
    () =>
      buildVisibleData(
        treeData,
        collapsedIds,
      ),
    [
      treeData,
      collapsedIds,
    ],
  );

  /* =======================================================
     Search - ALL PEOPLE
  ======================================================= */

  const searchResults =
    useMemo(() => {
      const term =
        searchTerm
          .trim()
          .toLowerCase();

      if (!term) {
        return [];
      }

      return people
        .filter((person) =>
          personName(person)
            .toLowerCase()
            .includes(term),
        )
        .slice(0, 8);
    }, [
      searchTerm,
      people,
    ]);

  const focusMaleOnTree =
    useCallback(
      (
        personId: string,
      ) => {
        const path =
          findPath(
            treeData,
            personId,
          );

        if (!path) {
          return;
        }

        const newCollapsedIds =
          new Set(
            collapsedIds,
          );

        for (const id of path) {
          newCollapsedIds.delete(
            id,
          );
        }

        const expandedData =
          buildVisibleData(
            treeData,
            newCollapsedIds,
          );

        const firstRoot =
          expandedData[0];

        const targetPos =
          firstRoot
            ? computeNodePosition(
                firstRoot,
                personId,
              )
            : null;

        setCollapsedIds(
          newCollapsedIds,
        );

        setHighlightId(
          personId,
        );

        if (
          targetPos &&
          dimensions.width > 0
        ) {
          const z =
            currentZoomRef.current;

          setTranslate({
            x:
              dimensions.width / 2 -
              targetPos.x * z,

            y:
              dimensions.height / 2 -
              targetPos.y * z,
          });

          setZoom(z);

          setTreeKey(
            `tree-${personId}-${Date.now()}`,
          );
        }
      },
      [
        treeData,
        collapsedIds,
        dimensions,
      ],
    );

  const handleSelectSearchResult =
    useCallback(
      (person: Person) => {
        setSearchTerm(
          personName(person),
        );

        setSearchMessage('');

        if (isMale(person)) {
          focusMaleOnTree(
            person.id,
          );

          setRelationPerson(
            person,
          );

          setSelectedPerson(
            { person },
          );

          return;
        }

        /*
         * Female:
         * do NOT insert her permanently
         * into the main tree.
         *
         * Instead open her relationship
         * diagram and focus her father
         * when available.
         */
        if (person.father_id) {
          const father =
            personMap.get(
              person.father_id,
            );

          if (father && isMale(father)) {
            focusMaleOnTree(
              father.id,
            );

            setHighlightId(
              father.id,
            );
          }
        }

        setRelationPerson(
          person,
        );

        setSelectedPerson(
          { person },
        );
      },
      [
        focusMaleOnTree,
        personMap,
      ],
    );

  const handleSearch =
    useCallback(() => {
      const term =
        searchTerm.trim();

      if (!term) {
        setSearchMessage(
          'اكتب اسم الشخص أولًا',
        );

        return;
      }

      const match =
        people.find(
          (person) =>
            personName(person)
              .toLowerCase() ===
            term.toLowerCase(),
        ) ||
        people.find(
          (person) =>
            personName(person)
              .toLowerCase()
              .includes(
                term.toLowerCase(),
              ),
        );

      if (!match) {
        setSearchMessage(
          'لم يُعثر على الاسم',
        );

        return;
      }

      handleSelectSearchResult(
        match,
      );
    }, [
      searchTerm,
      people,
      handleSelectSearchResult,
    ]);

  /* =======================================================
     Collapse
  ======================================================= */

  const toggleCollapse =
    useCallback(
      (id: string) => {
        setCollapsedIds(
          (previous) => {
            const next =
              new Set(previous);

            if (next.has(id)) {
              next.delete(id);
            } else {
              next.add(id);
            }

            return next;
          },
        );
      },
      [],
    );

  /* =======================================================
     Main tree update
  ======================================================= */

  const handleUpdate =
    useCallback(
      (state: {
        zoom: number;
      }) => {
        currentZoomRef.current =
          state.zoom;

        setZoom(state.zoom);
      },
      [],
    );

  /* =======================================================
     Main tree custom node
  ======================================================= */

  const renderNode =
    useCallback(
      (
        props: CustomNodeElementProps,
      ) => {
        const {
          nodeDatum,
        } = props;

        const id =
          nodeDatum.attributes
            ?.id as string;

        const title =
          nodeDatum.attributes
            ?.title as
            | string
            | undefined;

        const status =
          nodeDatum.attributes
            ?.status as
            | string
            | undefined;

        const isDead =
          status === 'متوفى' ||
          status === 'شهيد';

        const hasChildren =
          nodesWithChildren.has(
            id,
          );

        const isCollapsed =
          hasChildren &&
          (nodeDatum.children
            ?.length ?? 0) === 0;

        const isHighlighted =
          highlightId === id;

        const person =
          personMap.get(id);

        const handlePointerDown =
          (
            event: React.PointerEvent,
          ) => {
            event.currentTarget.setAttribute(
              'data-dx',
              String(
                event.clientX,
              ),
            );

            event.currentTarget.setAttribute(
              'data-dy',
              String(
                event.clientY,
              ),
            );
          };

        const handlePointerUp =
          (
            event: React.PointerEvent,
          ) => {
            const dx =
              parseFloat(
                event.currentTarget.getAttribute(
                  'data-dx',
                ) || '0',
              );

            const dy =
              parseFloat(
                event.currentTarget.getAttribute(
                  'data-dy',
                ) || '0',
              );

            const moved =
              Math.sqrt(
                (event.clientX -
                  dx) **
                  2 +
                  (event.clientY -
                    dy) **
                    2,
              ) > 10;

            if (moved) {
              return;
            }

            const target =
              event.target as SVGElement;

            const isArrow =
              target.getAttribute(
                'data-arrow',
              ) === 'true';

            if (
              isArrow &&
              hasChildren
            ) {
              toggleCollapse(id);
              return;
            }

            if (person) {
              setRelationPerson(
                person,
              );

              setSelectedPerson({
                person,
              });
            }
          };

        const nameWidth =
          nodeDatum.name.length *
            9 +
          (isDead ? 65 : 0) +
          28;

        const titleWidth =
          title
            ? title.length * 8 +
              28
            : 80;

        const rectWidth =
          Math.max(
            nameWidth,
            titleWidth,
            100,
          );

        const rectHeight =
          title ? 46 : 32;

        return (
          <g
            data-person-id={id}
            style={{
              cursor: 'pointer',
            }}
            onPointerDown={
              handlePointerDown
            }
            onPointerUp={
              handlePointerUp
            }
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            {isHighlighted && (
              <rect
                x={
                  -rectWidth / 2 - 7
                }
                y={
                  -rectHeight / 2 - 7
                }
                width={
                  rectWidth + 14
                }
                height={
                  rectHeight + 14
                }
                rx={10}
                fill="#fef3c7"
                stroke="#eab308"
                strokeWidth={3}
              />
            )}

            <rect
              x={
                -rectWidth / 2
              }
              y={
                -rectHeight / 2
              }
              width={rectWidth}
              height={rectHeight}
              rx={7}
              fill="#ffffff"
              stroke={
                isHighlighted
                  ? '#2563eb'
                  : '#cbd5e1'
              }
              strokeWidth={
                isHighlighted ? 2 : 1
              }
            />

            <text
              x="0"
              y={
                title
                  ? -7
                  : 5
              }
              textAnchor="middle"
              fill="#1e293b"
              fontSize="16"
              fontWeight="600"
              style={{
                fontFamily:
                  'Cairo, sans-serif',
              }}
            >
              {nodeDatum.name}

              {isDead && (
                <tspan
                  fill="#64748b"
                  fontSize="12"
                  dx="4"
                  fontWeight="400"
                >
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
                style={{
                  fontFamily:
                    'Cairo, sans-serif',
                }}
              >
                {title}
              </text>
            )}

            {hasChildren && (
              <g
                data-arrow="true"
                transform={`translate(${
                  rectWidth / 2 + 10
                }, 0)`}
              >
                <circle
                  r={10}
                  fill="#1e40af"
                  data-arrow="true"
                />

                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#ffffff"
                  fontSize="11"
                  fontWeight="700"
                  data-arrow="true"
                >
                  {isCollapsed
                    ? '▶'
                    : '▼'}
                </text>
              </g>
            )}
          </g>
        );
      },
      [
        nodesWithChildren,
        highlightId,
        personMap,
        toggleCollapse,
      ],
    );

  /* =======================================================
     Open relationship view
  ======================================================= */

  const openRelations =
    useCallback(
      (person: Person) => {
        setSelectedPerson(null);
        setRelationPerson(
          person,
        );
        setRelationOpen(true);
      },
      [],
    );

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
    const dead =
      isDeceased(person);

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
          dead
            ? 'border-slate-300'
            : 'border-slate-200',
        ].join(' ')}
      >
        <span
          className="text-sm font-bold text-slate-800"
        >
          {personName(person)}
        </span>

        {role && (
          <span className="mt-1 text-[11px] text-slate-500">
            {role}
          </span>
        )}

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
     Family branch (with children per spouse)
  ======================================================= */

  const FamilyBranch = ({
    family,
  }: {
    family: RelationFamily;
  }) => {
    const { person, spouses, childrenBySpouse } = family;

    // If there are no spouses, just show the person and their children (if any)
    if (spouses.length === 0) {
      const allChildren = Array.from(childrenBySpouse.values()).flat();
      return (
        <div className="flex flex-col items-center">
          <RelationPersonNode
            person={person}
            onClick={() =>
              openRelations(person)
            }
          />

          {allChildren.length > 0 && (
            <>
              <div className="h-8 w-px bg-slate-300" />
              <div className="relative flex items-start gap-4 pt-4">
                <div className="absolute top-0 left-1/2 h-px w-[calc(100%-80px)] -translate-x-1/2 bg-slate-300" />
                {allChildren.map((child) => (
                  <div
                    key={child.id}
                    className="relative flex flex-col items-center"
                  >
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

    // Show person + each spouse with their children
    return (
      <div className="flex flex-col items-center">
        <RelationPersonNode
          person={person}
          onClick={() => openRelations(person)}
        />

        {/* Spouses and their children */}
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
                        <div
                          key={child.id}
                          className="relative flex flex-col items-center"
                        >
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
    if (!relationView) {
      return null;
    }

    const {
      person,
      parent,
      siblingFamilies,
      ownFamily,
    } = relationView;

    return (
      <div
        className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[2px]"
        onClick={() =>
          setRelationOpen(false)
        }
      >
        <div
          className="absolute inset-4 md:inset-8 bg-slate-50 rounded-2xl shadow-2xl overflow-hidden"
          dir="rtl"
          onClick={(event) =>
            event.stopPropagation()
          }
        >
          {/* Header */}
          <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center">
                <GitBranch className="w-5 h-5" />
              </div>

              <div>
                <h2 className="font-bold text-slate-800">
                  العلاقات العائلية
                </h2>

                <p className="text-xs text-slate-500">
                  {personName(person)}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                setRelationOpen(false)
              }
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Diagram */}
          <div className="absolute inset-x-0 bottom-0 top-16 overflow-auto p-6">
            <div className="min-w-max min-h-full flex flex-col items-center gap-8 pb-16">
              {/* Parent */}
              {parent && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-slate-500 mb-2">
                    الأب
                  </div>

                  <RelationPersonNode
                    person={parent}
                    onClick={() =>
                      openRelations(
                        parent,
                      )
                    }
                  />

                  <div className="h-8 w-px bg-slate-300" />
                </div>
              )}

              {/* Selected person */}
              <div className="flex flex-col items-center">
                <div className="ring-2 ring-blue-500 ring-offset-4 rounded-xl">
                  <RelationPersonNode
                    person={person}
                    role="الشخص المحدد"
                  />
                </div>
              </div>

              {/* Own family */}
              <div className="flex flex-col items-center">
                <div className="h-8 w-px bg-slate-300" />

                <div className="text-xs text-slate-500 mb-3">
                  الأسرة والذرية
                </div>

                <FamilyBranch
                  family={ownFamily}
                />
              </div>

              {/* Siblings */}
              {siblingFamilies.length >
                0 && (
                <div className="w-full">
                  <div className="flex items-center justify-center gap-3 mb-5">
                    <div className="h-px w-12 bg-slate-300" />

                    <span className="text-sm font-bold text-slate-700">
                      الإخوة والأخوات وعائلاتهم
                    </span>

                    <div className="h-px w-12 bg-slate-300" />
                  </div>

                  <div className="flex items-start justify-center gap-8 flex-wrap">
                    {siblingFamilies.map(
                      (family) => (
                        <FamilyBranch
                          key={
                            family.person.id
                          }
                          family={
                            family
                          }
                        />
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* =======================================================
     Loading
  ======================================================= */

  if (
    loadState === 'loading'
  ) {
    return (
      <div
        dir="rtl"
        className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3"
      >
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />

        <p className="text-sm text-slate-600">
          جاري تحميل بيانات العائلة…
        </p>
      </div>
    );
  }

  /* =======================================================
     Error
  ======================================================= */

  if (
    loadState === 'error'
  ) {
    return (
      <div
        dir="rtl"
        className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4"
      >
        <AlertCircle className="w-8 h-8 text-red-600" />

        <p className="text-sm text-red-700 text-center max-w-xl">
          {errorMsg}
        </p>

        <a
          href="#/"
          className="text-sm text-blue-600 underline mt-2"
        >
          العودة للوحة التحكم
        </a>
      </div>
    );
  }

  /* =======================================================
     Empty
  ======================================================= */

  if (
    loadState === 'empty'
  ) {
    return (
      <div
        dir="rtl"
        className="flex flex-col items-center justify-center h-screen bg-slate-50 gap-3 px-4"
      >
        <AlertCircle className="w-8 h-8 text-amber-500" />

        <p className="text-sm text-slate-600 text-center max-w-md">
          لا توجد بيانات ذكور في قاعدة البيانات لعرض الشجرة.
        </p>

        <a
          href="#/"
          className="text-sm text-blue-600 underline mt-2"
        >
          العودة للوحة التحكم
        </a>
      </div>
    );
  }

  /* =======================================================
     Main UI
  ======================================================= */

  return (
    <div
      dir="rtl"
      className="flex flex-col h-screen bg-slate-50 overflow-hidden"
    >
      {/* Header */}
      <div className="relative z-20 bg-white border-b border-slate-200 px-3 md:px-4 py-3 flex items-center gap-3 flex-wrap shrink-0">
        <a
          href="#/"
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 shrink-0"
        >
          <ArrowRight className="w-4 h-4" />
          لوحة التحكم
        </a>

        <h1 className="text-base font-bold text-slate-800 shrink-0">
          شجرة العائلة
        </h1>

        <div className="flex-1 min-w-[240px] max-w-xl mx-auto">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />

            <input
              type="text"
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(
                  event.target.value,
                );

                setSearchMessage('');
              }}
              onKeyDown={(event) => {
                if (
                  event.key ===
                  'Enter'
                ) {
                  handleSearch();
                }
              }}
              placeholder="ابحث عن أي شخص: رجل أو امرأة…"
              className="w-full pr-9 pl-20 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-400"
            />

            <button
              type="button"
              onClick={
                handleSearch
              }
              className="absolute left-1 top-1 bottom-1 px-3 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              بحث
            </button>

            {/* Search suggestions */}
            {searchTerm.trim() &&
              searchResults.length >
                0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden z-50">
                  {searchResults.map(
                    (person) => (
                      <button
                        type="button"
                        key={person.id}
                        onClick={() =>
                          handleSelectSearchResult(
                            person,
                          )
                        }
                        className="w-full px-3 py-2.5 flex items-center gap-3 text-right hover:bg-slate-50 border-b last:border-b-0 border-slate-100"
                      >
                        <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                          <UserRound className="w-4 h-4 text-slate-500" />
                        </div>

                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-800 truncate">
                            {personName(
                              person,
                            )}
                          </div>

                          <div className="text-[11px] text-slate-500">
                            {isFemale(
                              person,
                            )
                              ? 'أنثى'
                              : 'ذكر'}

                            {person.family_title
                              ? ` • ${person.family_title}`
                              : ''}
                          </div>
                        </div>
                      </button>
                    ),
                  )}
                </div>
              )}
          </div>
        </div>

        <div className="hidden md:flex items-center gap-1 text-xs text-slate-400">
          <Users className="w-4 h-4" />

          <span>
            {people.length} شخص
          </span>
        </div>
      </div>

      {/* Search message */}
      {searchMessage && (
        <div className="relative z-10 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-700 text-center shrink-0">
          {searchMessage}
        </div>
      )}

      {/* Tree */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        onClick={() =>
          setHighlightId(null)
        }
      >
        {dimensions.width > 0 &&
          visibleData.length >
            0 && (
            <Tree
              key={treeKey}
              data={visibleData}
              orientation="vertical"
              pathFunc="diagonal"
              collapsible={false}
              depthFactor={
                DEPTH_FACTOR
              }
              nodeSize={NODE_SIZE}
              separation={
                SEPARATION
              }
              dimensions={
                dimensions
              }
              zoomable
              scaleExtent={{
                min: 0.1,
                max: 5,
              }}
              translate={
                translate
              }
              zoom={zoom}
              renderCustomNodeElement={
                renderNode
              }
              transitionDuration={
                300
              }
              onUpdate={
                handleUpdate
              }
            />
          )}

        {/* Floating selected-person card */}
        {selectedPerson && (
          <div
            className="absolute bottom-4 right-4 z-30 w-[300px] max-w-[calc(100%-32px)]"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-start justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                    <UserRound className="w-5 h-5" />
                  </div>

                  <div className="min-w-0">
                    <h2 className="font-bold text-slate-800 truncate">
                      {personName(
                        selectedPerson.person,
                      )}
                    </h2>

                    <p className="text-xs text-slate-500">
                      {isFemale(
                        selectedPerson.person,
                      )
                        ? 'أنثى'
                        : 'ذكر'}

                      {selectedPerson
                        .person
                        .family_title
                        ? ` • ${selectedPerson.person.family_title}`
                        : ''}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setSelectedPerson(
                      null,
                    )
                  }
                  className="text-slate-400 hover:text-slate-700 shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="px-4 py-3">
                <div className="grid grid-cols-3 gap-2 text-center mb-3">
                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">
                      الأبناء
                    </div>

                    <div className="font-bold text-slate-700">
                      {
                        getChildren(
                          selectedPerson
                            .person.id,
                        ).length
                      }
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">
                      الأزواج
                    </div>

                    <div className="font-bold text-slate-700">
                      {
                        getSpousesWithMarriage(
                          selectedPerson
                            .person.id,
                        ).length
                      }
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg py-2">
                    <div className="text-[10px] text-slate-400">
                      الإخوة
                    </div>

                    <div className="font-bold text-slate-700">
                      {
                        getSiblings(
                          selectedPerson
                            .person,
                        ).length
                      }
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    openRelations(
                      selectedPerson.person,
                    )
                  }
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
                >
                  <GitBranch className="w-4 h-4" />
                  استعراض العلاقات
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Small hint */}
        {!selectedPerson &&
          !relationOpen && (
            <div className="absolute bottom-4 left-4 z-10 bg-white/90 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm px-3 py-2 text-xs text-slate-500 pointer-events-none">
              اضغط على الشخص لاستعراض علاقاته
            </div>
          )}
      </div>

      {/* Relation overlay */}
      {relationOpen && (
        <RelationDiagram />
      )}
    </div>
  );
}
