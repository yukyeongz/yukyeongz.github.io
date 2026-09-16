import { Parser, Store } from 'n3';
import { QueryEngine } from '@comunica/query-sparql-rdfjs-lite';

const PREFIXES = `PREFIX rico: <https://www.ica.org/standards/RiC/ontology#>
PREFIX jb: <https://jbschools.kr/ontology/jb#>
PREFIX schema: <https://schema.org/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;

const EXAMPLES = [
  {
    label: '폐교된 학교/기관 목록',
    query: `${PREFIXES}
SELECT ?name ?status WHERE {
  ?s a rico:CorporateBody ; rico:name ?name ; jb:status ?status .
  FILTER(?status = "closed")
} ORDER BY ?name`,
  },
  {
    label: '정천중학교(S_00058) 통합 대상',
    query: `${PREFIXES}
SELECT ?target ?name WHERE {
  <https://jbschools.kr/id/school/S_00058> rico:wasMergedInto ?target .
  ?target rico:name ?name .
}`,
  },
  {
    label: '승계(succeeds) 관계 전체',
    query: `${PREFIXES}
SELECT ?predName ?succName WHERE {
  ?pred rico:name ?predName .
  ?succ rico:isSuccessorOf ?pred ; rico:name ?succName .
}`,
  },
  {
    label: '"진안동국민학교" 명칭의 시기별 학교',
    query: `${PREFIXES}
SELECT ?schoolId ?currentName ?begin ?end
WHERE {
  ?name rico:name "진안동국민학교"@ko .

  ?apprel rico:relationHasSource ?name ;
          rico:relationHasTarget ?school ;
          rico:hasBeginningDate ?beginNode ;
          rico:hasEndDate ?endNode .

  ?beginNode rico:normalizedDateValue ?begin .
  ?endNode   rico:normalizedDateValue ?end .

  ?school rico:identifier ?schoolId ;
          rico:name ?currentName .
}
ORDER BY ?begin`,
  },
  {
    label: '타입별 개체 수',
    query: `${PREFIXES}
SELECT ?type (COUNT(?s) AS ?count) WHERE {
  ?s a ?type .
} GROUP BY ?type ORDER BY DESC(?count)`,
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

  const exampleContainer = document.getElementById('examples');
  for (const ex of EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex.label;
    btn.addEventListener('click', () => {
      document.getElementById('query-box').value = ex.query.trim();
      runQuery(ex.query);
    });
    exampleContainer.appendChild(btn);
  }

  document.getElementById('run-btn').addEventListener('click', () => {
    const sparql = document.getElementById('query-box').value;
    runQuery(sparql);
  });

  document.getElementById('query-box').value = EXAMPLES[0].query.trim();
  setStatus('준비 완료');
}

init().catch((err) => setStatus(`초기화 실패: ${err.message}`, true));
