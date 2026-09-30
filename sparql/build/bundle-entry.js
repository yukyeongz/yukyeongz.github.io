import { Parser, Store } from 'n3';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';

const PREFIXES = `PREFIX rico: <https://www.ica.org/standards/RiC/ontology#>
PREFIX jb: <https://jbschools.kr/ontology/jb#>
PREFIX schema: <https://schema.org/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

// 정규식 메타문자 이스케이프(문자 1개 단위)
function escapeRegexChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 입력 문자열 → "글자가 순서대로만 나오면 매칭"되는 부분열(subsequence) 정규식 패턴.
// 예: "한기부고" → "한.*기.*부.*고.*" → "한국기술부사관고등학교"에 매칭.
// 콤보박스 제안 목록을 좁히는 용도로만 쓴다(클라이언트 JS) — 실제 SPARQL 조회는 완전일치로 한다
// (아래 escapeSparqlString/두 용도 분리 참고).
function buildSubsequenceRegex(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  return new RegExp([...trimmed].map(escapeRegexChar).join('.*'));
}

// 문자열을 SPARQL 문자열 리터럴 안에 안전하게 삽입하기 위한 이스케이프(완전일치 FILTER용).
function escapeSparqlString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const TEMPLATE_GROUPS = [
  {
    category: '1. 동명이교 구분',
    items: [
      {
        label: '같은 명칭을 쓴 모든 학교(시기별 + 현재 교명)',
        param: { label: '명칭(콤보박스에서 선택, 과거 사용된 이름 포함)', default: '진안동국민학교' },
        build: (value) => `${PREFIXES}
SELECT ?nameLabel ?schoolId ?currentName ?begin ?end
WHERE {
  ?name a rico:AgentName ;
        skos:prefLabel ?nameLabel .
  FILTER(STR(?nameLabel) = "${escapeSparqlString(value)}")
  ?apprel a rico:AppellationRelation ;
          rico:relationHasSource ?name ;
          rico:relationHasTarget ?school .
  OPTIONAL { ?apprel rico:hasBeginningDate/rico:normalizedDateValue ?begin }
  OPTIONAL { ?apprel rico:hasEndDate/rico:normalizedDateValue ?end }
  ?school rico:identifier ?schoolId ;
          rico:name ?currentName .
}
ORDER BY ?begin`,
      },
    ],
  },
  {
    category: '2. 이명동교 식별',
    items: [
      {
        label: '한 학교가 사용한 모든 명칭과 사용기간',
        param: { label: '학교명(콤보박스에서 선택, 약칭 입력 가능)', default: '한국기술부사관고등학교' },
        build: (value) => `${PREFIXES}
SELECT ?nameLabel ?begin ?end ?matchedSchool
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(STR(?matchedSchool) = "${escapeSparqlString(value)}")
  ?school rico:hasOrHadAgentName ?name .
  ?name skos:prefLabel ?nameLabel .
  OPTIONAL {
    ?apprel a rico:AppellationRelation ;
            rico:relationHasSource ?name ;
            rico:relationHasTarget ?school .
    OPTIONAL { ?apprel rico:hasBeginningDate/rico:normalizedDateValue ?begin }
    OPTIONAL { ?apprel rico:hasEndDate/rico:normalizedDateValue ?end }
  }
}
ORDER BY ?begin`,
      },
    ],
  },
  {
    category: '3. 본교/분교 관계 파악',
    items: [
      {
        label: '분교 설치/편입 · 독립/승격 이력 전체(방향 표시)',
        param: { label: '학교명(콤보박스에서 선택, 약칭 입력 가능)', default: '주천국민학교 선봉분교장' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?relKind ?otherName ?date
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(STR(?matchedSchool) = "${escapeSparqlString(value)}")
  ?rel a rico:AgentHierarchicalRelation ;
       rico:relationHasSource ?src ;
       rico:relationHasTarget ?tgt ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(?src = ?school || ?tgt = ?school)
  BIND(
    IF(CONTAINS(STR(?rel), "_is_branch_of_"),
      IF(?src = ?school, "분교 설치(자신이 본교)", "분교로 편입(자신이 분교)"),
      IF(?src = ?school, "독립(자신이 분교→본교로 승격)", "소속 분교 독립(자신이 본교)")
    ) AS ?relKind
  )
  BIND(IF(?tgt = ?school, ?src, ?tgt) AS ?other)
  ?other rico:name ?otherName .
}
ORDER BY ?date`,
      },
    ],
  },
  {
    category: '4. 통폐합 및 승계 관계 파악',
    items: [
      {
        label: '학교 X가 통합(흡수)된 대상 + 날짜 + 대상 학교 현존여부/재통합',
        param: { label: '학교명(콤보박스에서 선택, 약칭 입력 가능)', default: '월포국민학교' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?targetName ?date ?targetStatus ?nextMergeTargetName ?nextMergeDate
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(STR(?matchedSchool) = "${escapeSparqlString(value)}")
  ?rel a rico:AgentTemporalRelation ;
       rico:relationHasSource ?school ;
       rico:relationHasTarget ?target ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(CONTAINS(STR(?rel), "_merges_into_"))
  ?target rico:name ?targetName ;
          jb:status ?targetStatus .
  OPTIONAL {
    ?rel2 a rico:AgentTemporalRelation ;
          rico:relationHasSource ?target ;
          rico:relationHasTarget ?target2 ;
          rico:relationHasDate/rico:normalizedDateValue ?nextMergeDate .
    FILTER(CONTAINS(STR(?rel2), "_merges_into_"))
    ?target2 rico:name ?nextMergeTargetName .
  }
}
ORDER BY ?date`,
      },
      {
        label: '학교 X로 통합되어 들어온 학교 목록 + 날짜 + 원 소속 학교 현존여부',
        param: { label: '학교명(콤보박스에서 선택, 약칭 입력 가능)', default: '진안중앙초등학교' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?sourceName ?date ?sourceStatus
WHERE {
  ?target rico:name ?matchedSchool .
  FILTER(STR(?matchedSchool) = "${escapeSparqlString(value)}")
  ?rel a rico:AgentTemporalRelation ;
       rico:relationHasSource ?source ;
       rico:relationHasTarget ?target ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(CONTAINS(STR(?rel), "_merges_into_"))
  ?source rico:name ?sourceName ;
          jb:status ?sourceStatus .
}
ORDER BY ?date`,
      },
      {
        label: '승계(succeeds) 관계 전체 + 날짜',
        param: null,
        build: () => `${PREFIXES}
SELECT ?predName ?succName ?date
WHERE {
  ?succ rico:isSuccessorOf ?pred .
  ?pred rico:name ?predName .
  ?succ rico:name ?succName .
  OPTIONAL {
    ?rel a rico:AgentTemporalRelation ;
         rico:relationHasSource ?succ ;
         rico:relationHasTarget ?pred ;
         rico:relationHasDate/rico:normalizedDateValue ?date .
    FILTER(CONTAINS(STR(?rel), "_succeeds_"))
  }
}
ORDER BY ?date`,
      },
    ],
  },
  {
    category: '5. 통합운영학교 관계 파악',
    items: [
      {
        label: '현재 통합운영 중인 학교 쌍 + 시작일',
        param: null,
        build: () => `${PREFIXES}
SELECT DISTINCT ?school1Name ?school2Name ?startDate
WHERE {
  ?s1 jb:coManagedWith ?s2 .
  FILTER(STR(?s1) < STR(?s2))
  ?s1 rico:name ?school1Name .
  ?s2 rico:name ?school2Name .
  OPTIONAL {
    ?rel a rico:Relation ;
         rico:relationConnects ?s1, ?s2 ;
         rico:relationHasDate/rico:normalizedDateValue ?startDate .
    FILTER(CONTAINS(STR(?rel), "_co_managed_with_"))
  }
  FILTER NOT EXISTS { ?s1 jb:endedCoManagementWith ?s2 }
}`,
      },
      {
        label: '통합운영이 종료된 학교 쌍 + 시작일~종료일',
        param: null,
        build: () => `${PREFIXES}
SELECT ?school1Name ?school2Name ?startDate ?endDate
WHERE {
  ?s1 jb:endedCoManagementWith ?s2 .
  FILTER(STR(?s1) < STR(?s2))
  ?s1 rico:name ?school1Name .
  ?s2 rico:name ?school2Name .
  ?relEnd a rico:Relation ;
          rico:relationConnects ?s1, ?s2 ;
          rico:relationHasDate/rico:normalizedDateValue ?endDate .
  FILTER(CONTAINS(STR(?relEnd), "_co_management_ended_"))
  OPTIONAL {
    ?relStart a rico:Relation ;
              rico:relationConnects ?s1, ?s2 ;
              rico:relationHasDate/rico:normalizedDateValue ?startDate .
    FILTER(CONTAINS(STR(?relStart), "_co_managed_with_"))
  }
}`,
      },
    ],
  },
  {
    category: '6. 학교별 전체 연혁 조회',
    items: [
      {
        label: '한 학교의 교명·분교·통합·승계·통합운영 이력 전체(시간순)',
        param: { label: '학교명(콤보박스에서 선택, 약칭 입력 가능)', default: '진안초등학교' },
        // Comunica(@comunica/query-sparql-rdfjs-lite)가 "공유 패턴 하나 + 뒤이은 여러 겹
        // UNION" 구조에서 왼쪽 UNION 분기 이후의 결과를 조인 단계에서 누락시키는 현상이
        // 실측 확인됐다(예: 분교 설치 이력 분기가 통째로 사라짐) — 학교명을 고정하는 패턴을
        // 매 UNION 분기 안에 그대로 복제해 넣는 방식으로 우회한다(다소 장황하지만 안전).
        build: (value) => {
          const hostBind = `?school rico:name ?matchedSchoolName .
    FILTER(STR(?matchedSchoolName) = "${escapeSparqlString(value)}")`;
          return `${PREFIXES}
SELECT ?kind ?detail ?date
WHERE {
  {
    ${hostBind}
    ?school rico:hasOrHadAgentName ?name .
    ?name skos:prefLabel ?detail .
    ?apprel a rico:AppellationRelation ;
            rico:relationHasSource ?name ;
            rico:relationHasTarget ?school .
    OPTIONAL { ?apprel rico:hasBeginningDate/rico:normalizedDateValue ?date }
    BIND("교명 사용 시작" AS ?kind)
  } UNION {
    ${hostBind}
    ?rel a rico:AgentHierarchicalRelation ;
         rico:relationHasSource ?src ;
         rico:relationHasTarget ?tgt ;
         rico:relationHasDate/rico:normalizedDateValue ?date .
    FILTER(?src = ?school || ?tgt = ?school)
    BIND(
      IF(CONTAINS(STR(?rel), "_is_branch_of_"),
        IF(?src = ?school, "분교 설치(자신이 본교)", "분교로 편입(자신이 분교)"),
        IF(?src = ?school, "독립(자신이 분교→본교로 승격)", "소속 분교 독립(자신이 본교)")
      ) AS ?kind
    )
    BIND(IF(?tgt = ?school, ?src, ?tgt) AS ?other)
    ?other rico:name ?detail .
  } UNION {
    ${hostBind}
    ?rel a rico:AgentTemporalRelation ;
         rico:relationHasSource ?school ;
         rico:relationHasTarget ?tgt ;
         rico:relationHasDate/rico:normalizedDateValue ?date .
    FILTER(CONTAINS(STR(?rel), "_merges_into_"))
    ?tgt rico:name ?detail .
    BIND("통합(흡수됨)" AS ?kind)
  } UNION {
    ${hostBind}
    ?rel a rico:AgentTemporalRelation ;
         rico:relationHasSource ?src ;
         rico:relationHasTarget ?school ;
         rico:relationHasDate/rico:normalizedDateValue ?date .
    FILTER(CONTAINS(STR(?rel), "_merges_into_"))
    ?src rico:name ?detail .
    BIND("통합(흡수함)" AS ?kind)
  } UNION {
    ${hostBind}
    ?school rico:isSuccessorOf ?pred .
    ?pred rico:name ?detail .
    BIND("승계(자신의 전신)" AS ?kind)
    OPTIONAL {
      ?rel a rico:AgentTemporalRelation ;
           rico:relationHasSource ?school ;
           rico:relationHasTarget ?pred ;
           rico:relationHasDate/rico:normalizedDateValue ?date .
      FILTER(CONTAINS(STR(?rel), "_succeeds_"))
    }
  } UNION {
    ${hostBind}
    ?succ rico:isSuccessorOf ?school .
    ?succ rico:name ?detail .
    BIND("승계(자신의 후신)" AS ?kind)
    OPTIONAL {
      ?rel a rico:AgentTemporalRelation ;
           rico:relationHasSource ?succ ;
           rico:relationHasTarget ?school ;
           rico:relationHasDate/rico:normalizedDateValue ?date .
      FILTER(CONTAINS(STR(?rel), "_succeeds_"))
    }
  } UNION {
    ${hostBind}
    ?school jb:coManagedWith ?other .
    ?other rico:name ?detail .
    BIND("통합운영" AS ?kind)
    OPTIONAL {
      ?rel a rico:Relation ;
           rico:relationConnects ?school, ?other ;
           rico:relationHasDate/rico:normalizedDateValue ?date .
      FILTER(CONTAINS(STR(?rel), "_co_managed_with_"))
    }
  } UNION {
    ${hostBind}
    ?school jb:endedCoManagementWith ?other .
    ?other rico:name ?detail .
    BIND("통합운영 종료" AS ?kind)
    OPTIONAL {
      ?rel a rico:Relation ;
           rico:relationConnects ?school, ?other ;
           rico:relationHasDate/rico:normalizedDateValue ?date .
      FILTER(CONTAINS(STR(?rel), "_co_management_ended_"))
    }
  }
}
ORDER BY ?date`;
        },
      },
    ],
  },
  {
    category: '기타 유틸리티',
    items: [
      {
        label: '폐교/폐지된 학교·기관 — 현존여부 + 통합·승계 대상 및 날짜',
        param: null,
        build: () => `${PREFIXES}
SELECT ?name ?status ?mergedIntoName ?mergeDate ?succeededByName ?succDate
WHERE {
  ?s a rico:CorporateBody ; rico:name ?name ; jb:status "closed" .
  BIND("closed" AS ?status)
  OPTIONAL {
    ?relM a rico:AgentTemporalRelation ;
          rico:relationHasSource ?s ;
          rico:relationHasTarget ?tgt .
    FILTER(CONTAINS(STR(?relM), "_merges_into_"))
    ?tgt rico:name ?mergedIntoName .
    OPTIONAL { ?relM rico:relationHasDate/rico:normalizedDateValue ?mergeDate }
  }
  OPTIONAL {
    ?relS a rico:AgentTemporalRelation ;
          rico:relationHasSource ?succ ;
          rico:relationHasTarget ?s .
    FILTER(CONTAINS(STR(?relS), "_succeeds_"))
    ?succ rico:name ?succeededByName .
    OPTIONAL { ?relS rico:relationHasDate/rico:normalizedDateValue ?succDate }
  }
}
ORDER BY ?name`,
      },
      {
        label: '타입별 개체 수',
        param: null,
        build: () => `${PREFIXES}
SELECT ?type (COUNT(?s) AS ?count) WHERE {
  ?s a ?type .
} GROUP BY ?type ORDER BY DESC(?count)`,
      },
    ],
  },
];

const state = { store: null, engine: null, schoolNames: [] };

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status';
}

// SELECT 절에 적은 변수 순서 그대로 컬럼을 표시하기 위한 파싱. Comunica의 Bindings는
// SELECT 절 순서를 보존한다는 보장이 없어(내부적으로 패턴 매칭 순서를 따를 수 있음),
// 화면 컬럼 순서는 항상 SPARQL 텍스트의 SELECT 절에서 직접 뽑아써야 한다. "(expr AS ?x)"
// 형태의 집계/바인딩 변수도 지원한다. 파싱 실패 시(예: SELECT *)에는 null을 반환해
// 호출부가 바인딩 자체의 키 순서로 폴백하게 한다.
function extractSelectVars(sparql) {
  const m = sparql.match(/SELECT\s+(?:DISTINCT\s+)?(.+?)\s+WHERE/is);
  if (!m) return null;
  const clause = m[1];
  const vars = [];
  const re = /\(\s*.*?\s+AS\s+\?(\w+)\s*\)|\?(\w+)/gi;
  let mm;
  while ((mm = re.exec(clause))) {
    vars.push(mm[1] || mm[2]);
  }
  return vars.length ? vars : null;
}

function renderResults(bindings, varOrder) {
  const container = document.getElementById('results');
  container.innerHTML = '';
  if (bindings.length === 0) {
    container.textContent = '결과 없음';
    return;
  }
  const vars = varOrder && varOrder.length ? varOrder : [...bindings[0].keys()].map((k) => k.value);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const v of vars) {
    const th = document.createElement('th');
    th.textContent = v;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const binding of bindings) {
    const tr = document.createElement('tr');
    for (const v of vars) {
      const td = document.createElement('td');
      const term = binding.get(v);
      td.textContent = term ? term.value : '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  const count = document.createElement('p');
  count.className = 'result-count';
  count.textContent = `${bindings.length}건`;
  container.prepend(count);
}

async function runQuery(sparql) {
  setStatus('쿼리 실행 중...');
  try {
    const bindingsStream = await state.engine.queryBindings(sparql, { sources: [state.store] });
    const bindings = await bindingsStream.toArray();
    renderResults(bindings, extractSelectVars(sparql));
    setStatus('완료');
  } catch (err) {
    setStatus(`오류: ${err.message}`, true);
    document.getElementById('results').innerHTML = '';
  }
}

// 학교명 콤보박스 — 그래프의 모든 rico:AgentName(skos:prefLabel) 값만 모은 순수 문자열
// 목록을 클라이언트 JS에서 부분열(subsequence) 매칭으로 필터링해 제안한다. 관계(분교/통합/
// 승계 등) 순회를 전혀 하지 않는 단순 목록이라, 학교 간 관계를 SPARQL로 조회할 때 생길 수
// 있는 오매칭과 무관하게 항상 "실제로 존재하는 교명"만 제안한다. 목록에서 고른 값은 쿼리
// 실행 시 완전일치(FILTER(?x = "..."))로만 쓴다.
async function loadSchoolNames() {
  const sparql = `${PREFIXES}
SELECT DISTINCT ?label WHERE { ?name a rico:AgentName ; skos:prefLabel ?label } ORDER BY ?label`;
  const bindingsStream = await state.engine.queryBindings(sparql, { sources: [state.store] });
  const bindings = await bindingsStream.toArray();
  state.schoolNames = bindings.map((b) => b.get('label').value);
}

function closeCombo(box) {
  box.list.innerHTML = '';
  box.list.style.display = 'none';
}

function attachCombobox(input) {
  const list = document.createElement('div');
  list.className = 'combo-list';
  input.insertAdjacentElement('afterend', list);
  const box = { input, list };

  input.addEventListener('input', () => {
    const re = buildSubsequenceRegex(input.value);
    if (!re) {
      closeCombo(box);
      return;
    }
    const matches = state.schoolNames.filter((n) => re.test(n));
    matches.sort((a, b) => {
      const aStarts = a.startsWith(input.value) ? 0 : 1;
      const bStarts = b.startsWith(input.value) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      if (a.length !== b.length) return a.length - b.length;
      return a.localeCompare(b, 'ko');
    });
    const top = matches.slice(0, 30);
    list.innerHTML = '';
    if (top.length === 0) {
      closeCombo(box);
      return;
    }
    for (const name of top) {
      const item = document.createElement('div');
      item.className = 'combo-item';
      item.textContent = name;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = name;
        closeCombo(box);
      });
      list.appendChild(item);
    }
    list.style.display = 'block';
  });

  input.addEventListener('blur', () => {
    setTimeout(() => closeCombo(box), 150);
  });
}

function renderTemplates() {
  const container = document.getElementById('examples');
  container.innerHTML = '';

  for (const group of TEMPLATE_GROUPS) {
    const groupEl = document.createElement('div');
    groupEl.className = 'tpl-group';

    const h3 = document.createElement('h3');
    h3.textContent = group.category;
    groupEl.appendChild(h3);

    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'tpl-item';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'tpl-label';
      labelSpan.textContent = item.label;
      row.appendChild(labelSpan);

      let input = null;
      if (item.param) {
        const wrap = document.createElement('span');
        wrap.className = 'combo-wrap';
        input = document.createElement('input');
        input.type = 'text';
        input.value = item.param.default;
        input.title = item.param.label;
        input.placeholder = item.param.label;
        input.autocomplete = 'off';
        wrap.appendChild(input);
        row.appendChild(wrap);
        attachCombobox(input);
      }

      const btn = document.createElement('button');
      btn.textContent = item.param ? '조회' : '실행';
      btn.addEventListener('click', () => {
        const q = item.param ? item.build(input.value) : item.build();
        document.getElementById('query-box').value = q.trim();
        runQuery(q);
      });
      row.appendChild(btn);

      groupEl.appendChild(row);
    }

    container.appendChild(groupEl);
  }
}

async function init() {
  setStatus('public.ttl 불러오는 중...');
  const res = await fetch('./public.ttl');
  const text = await res.text();

  setStatus('데이터 파싱 중...');
  const store = new Store();
  const parser = new Parser({ format: 'text/turtle' });
  store.addQuads(parser.parse(text));
  state.store = store;
  state.engine = new QueryEngine();

  document.getElementById('triple-count').textContent = `${store.size.toLocaleString()} 트리플 로드됨`;

  await loadSchoolNames();
  renderTemplates();

  document.getElementById('run-btn').addEventListener('click', () => {
    const sparql = document.getElementById('query-box').value;
    runQuery(sparql);
  });

  const firstItem = TEMPLATE_GROUPS[0].items[0];
  const firstQuery = firstItem.param ? firstItem.build(firstItem.param.default) : firstItem.build();
  document.getElementById('query-box').value = firstQuery.trim();
  setStatus('준비 완료');
}

init().catch((err) => setStatus(`초기화 실패: ${err.message}`, true));
