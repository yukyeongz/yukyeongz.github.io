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
function buildSubsequenceRegex(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '.*';
  return [...trimmed].map(escapeRegexChar).join('.*') + '.*';
}

// 정규식 패턴 문자열을 SPARQL 문자열 리터럴 안에 안전하게 삽입하기 위한 이스케이프.
function escapeSparqlLiteral(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function matchRegex(value) {
  return escapeSparqlLiteral(buildSubsequenceRegex(value));
}

const TEMPLATE_GROUPS = [
  {
    category: '1. 동명이교 구분',
    items: [
      {
        label: '같은 명칭을 쓴 모든 학교(시기별 + 현재 교명)',
        param: { label: '명칭(과거 사용된 이름 포함, 약칭 가능)', default: '진안동국민학교' },
        build: (value) => `${PREFIXES}
SELECT ?nameLabel ?schoolId ?currentName ?begin ?end
WHERE {
  ?name rico:name ?nameLabel .
  FILTER(REGEX(?nameLabel, "${matchRegex(value)}"))
  ?apprel rico:relationHasSource ?name ;
          rico:relationHasTarget ?school .
  OPTIONAL { ?apprel rico:hasBeginningDate/rico:normalizedDateValue ?begin }
  OPTIONAL { ?apprel rico:hasEndDate/rico:normalizedDateValue ?end }
  ?school rico:identifier ?schoolId ;
          rico:name ?currentName .
}
ORDER BY ?nameLabel ?begin`,
      },
    ],
  },
  {
    category: '2. 이명동교 식별',
    items: [
      {
        label: '한 학교가 사용한 모든 명칭과 사용기간',
        param: { label: '학교명(약칭 가능, 예: 한기부고)', default: '한기부고' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?nameLabel ?begin ?end
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(REGEX(?matchedSchool, "${matchRegex(value)}"))
  ?school rico:hasOrHadAgentName ?name .
  ?name rico:name ?nameLabel .
  OPTIONAL {
    ?apprel rico:relationHasSource ?name ;
            rico:relationHasTarget ?school .
    OPTIONAL { ?apprel rico:hasBeginningDate/rico:normalizedDateValue ?begin }
    OPTIONAL { ?apprel rico:hasEndDate/rico:normalizedDateValue ?end }
  }
}
ORDER BY ?matchedSchool ?begin`,
      },
    ],
  },
  {
    category: '3. 본교/분교 관계 파악',
    items: [
      {
        label: '분교 편입 · 독립(본교 승격) 이력 전체',
        param: { label: '학교명(약칭 가능)', default: '주천국민학교 선봉분교장' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?relKind ?otherName ?date
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(REGEX(?matchedSchool, "${matchRegex(value)}"))
  ?rel a rico:AgentHierarchicalRelation ;
       rico:relationHasSource ?src ;
       rico:relationHasTarget ?tgt ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(?src = ?school || ?tgt = ?school)
  BIND(IF(CONTAINS(STR(?rel), "_is_branch_of_"), "분교로 편입", "독립(본교로 승격)") AS ?relKind)
  BIND(IF(?tgt = ?school, ?src, ?tgt) AS ?other)
  ?other rico:name ?otherName .
}
ORDER BY ?matchedSchool ?date`,
      },
    ],
  },
  {
    category: '4. 통폐합 및 승계 관계 파악',
    items: [
      {
        label: '학교 X가 통합(흡수)된 대상 + 날짜',
        param: { label: '학교명(약칭 가능)', default: '월포국민학교' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?targetName ?date
WHERE {
  ?school rico:name ?matchedSchool .
  FILTER(REGEX(?matchedSchool, "${matchRegex(value)}"))
  ?rel a rico:AgentTemporalRelation ;
       rico:relationHasSource ?school ;
       rico:relationHasTarget ?target ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(CONTAINS(STR(?rel), "_merges_into_"))
  ?target rico:name ?targetName .
}
ORDER BY ?matchedSchool ?date`,
      },
      {
        label: '학교 X로 통합되어 들어온 학교 목록 + 날짜',
        param: { label: '학교명(약칭 가능)', default: '진안중앙초등학교' },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?sourceName ?date
WHERE {
  ?target rico:name ?matchedSchool .
  FILTER(REGEX(?matchedSchool, "${matchRegex(value)}"))
  ?rel a rico:AgentTemporalRelation ;
       rico:relationHasSource ?source ;
       rico:relationHasTarget ?target ;
       rico:relationHasDate/rico:normalizedDateValue ?date .
  FILTER(CONTAINS(STR(?rel), "_merges_into_"))
  ?source rico:name ?sourceName .
}
ORDER BY ?matchedSchool ?date`,
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
    category: '기타 유틸리티',
    items: [
      {
        label: '폐교/폐지된 학교·기관 — 통합·승계 대상 및 날짜',
        param: null,
        build: () => `${PREFIXES}
SELECT ?name ?mergedIntoName ?mergeDate ?succeededByName ?succDate
WHERE {
  ?s a rico:CorporateBody ; rico:name ?name ; jb:status "closed" .
  OPTIONAL {
    ?relM a rico:AgentTemporalRelation ;
          rico:relationHasSource ?s ;
          rico:relationHasTarget ?tgt ;
          rico:relationHasDate/rico:normalizedDateValue ?mergeDate .
    FILTER(CONTAINS(STR(?relM), "_merges_into_"))
    ?tgt rico:name ?mergedIntoName .
  }
  OPTIONAL {
    ?relS a rico:AgentTemporalRelation ;
          rico:relationHasSource ?succ ;
          rico:relationHasTarget ?s ;
          rico:relationHasDate/rico:normalizedDateValue ?succDate .
    FILTER(CONTAINS(STR(?relS), "_succeeds_"))
    ?succ rico:name ?succeededByName .
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

const state = { store: null, engine: null };

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status';
}

function renderResults(bindings) {
  const container = document.getElementById('results');
  container.innerHTML = '';
  if (bindings.length === 0) {
    container.textContent = '결과 없음';
    return;
  }
  const vars = [...bindings[0].keys()].map((k) => k.value);
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
    renderResults(bindings);
    setStatus('완료');
  } catch (err) {
    setStatus(`오류: ${err.message}`, true);
    document.getElementById('results').innerHTML = '';
  }
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
        input = document.createElement('input');
        input.type = 'text';
        input.value = item.param.default;
        input.title = item.param.label;
        input.placeholder = item.param.label;
        row.appendChild(input);
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
