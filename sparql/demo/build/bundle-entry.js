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

// 콤보박스는 학교의 "현재 교명"뿐 아니라 과거에 썼던 모든 교명도 후보로 보여준다
// (동명이교 구분을 위해 필요). 그런데 학교를 특정하는 나머지 쿼리(2/3/4/6)가
// `?school rico:name ?x`(현재 교명 하나)로만 필터링하면, 과거 교명을 골랐을 때
// 학교 자체를 못 찾아 "결과 없음"이 된다(예: "진안농업고등학교" 선택 시 0건 —
// 실측 확인: 콤보박스 후보 182개 중 114개가 이 함정에 걸림). 대신 "이 학교가
// 한 번이라도 썼던 이름" 기준(AgentName + hasOrHadAgentName)으로 학교를 찾은 뒤,
// 화면 표시용 현재 교명은 별도로 다시 조회한다. schoolVar/matchedVar로 변수명을
// 바꿔 쓸 수 있게 해 "학교 X로 통합되어 들어온 학교"처럼 검색 대상이 ?school이
// 아니라 ?target인 경우도 재사용한다.
//
// [성능] 이름은 FILTER(STR(?label) = "...")가 아니라 VALUES로 값을 먼저 고정해 찾는다.
// 데이터의 교명은 모두 "진안초등학교"@ko처럼 언어 태그가 붙어 있어 예전에는 STR()로 태그를
// 떼고 비교했는데, Comunica는 이 FILTER로 범위를 먼저 좁히지 않고 교명 181개 전체를 나머지
// 패턴과 모두 조합한 뒤 마지막에 걸러서 매우 느렸다(실측: 학교 역사 약 14초 → 0.6초,
// 분교 기록 약 9초 → 0.2초, 결과는 동일). 태그가 붙은 형태와 태그 없는 형태를 둘 다 넣어
// 두었으므로, 나중에 태그 없는 교명이 데이터에 추가돼도 찾을 수 있다(속도 차이 없음).
// 약칭 검색은 여기와 무관하다 — 콤보박스가 정식 교명을 골라 주고, 조회는 늘 완전일치다.
function nameValues(varName, value) {
  const e = escapeSparqlString(value);
  return `VALUES ?${varName} { "${e}"@ko "${e}" }`;
}

function resolveSchoolClause(value, schoolVar = 'school', matchedVar = 'matchedSchool') {
  return `${nameValues('searchLabel', value)}
  ?searchName a rico:AgentName ; skos:prefLabel ?searchLabel .
  ?${schoolVar} rico:hasOrHadAgentName ?searchName ;
          rico:name ?${matchedVar} .`;
}

// 화면용 템플릿 목록. 각 build 함수(= 실제 SPARQL)는 개편 전 원본과 한 글자도 다르지 않으며,
// 바뀐 것은 순서와 화면 문구(title/desc/param.label)와 결과 표 열 이름표(columns)뿐이다.
// 시민 대상 시연을 고려해 가장 대표적인 "학교 역사"를 맨 앞에 두고, 소수 사례인 동명이교는
// 뒤쪽(7번)으로 옮겼다. 첫 번째 항목은 페이지를 열었을 때 쿼리 입력창에 미리 채워진다.
const TEMPLATE_GROUPS = [
  {
    category: "1. 학교 역사 한눈에 보기",
    items: [
      {
        title: "이 학교는 어떤 역사를 거쳐 왔나요?",
        desc: "학교를 고르면 이름이 바뀐 사건, 분교가 생기거나 독립한 사건, 다른 학교와 합쳐지거나 이어진 사건을 날짜순으로 모두 보여드립니다.",
        param: { label: "학교 이름 (옛 이름이나 줄임말로도 찾을 수 있어요)", default: "진안초등학교" },
        columns: { kind: "구분", detail: "내용", date: "날짜" },
        // Comunica(@comunica/query-sparql-rdfjs-lite)가 "공유 패턴 하나 + 뒤이은 여러 겹
        // UNION" 구조에서 왼쪽 UNION 분기 이후의 결과를 조인 단계에서 누락시키는 현상이
        // 실측 확인됐다(예: 분교 설치 이력 분기가 통째로 사라짐) — 학교명을 고정하는 패턴을
        // 매 UNION 분기 안에 그대로 복제해 넣는 방식으로 우회한다(다소 장황하지만 안전).
        build: (value) => {
          const hostBind = resolveSchoolClause(value);
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
    category: "2. 학교 이름이 바뀐 기록",
    items: [
      {
        title: "이 학교는 어떤 이름들을 거쳐 왔나요?",
        desc: "한 학교가 써 온 이름과 각 이름을 쓴 기간을 보여드립니다. (예: ○○국민학교 → ○○초등학교)",
        param: { label: "학교 이름 (옛 이름이나 줄임말로도 찾을 수 있어요)", default: "한국기술부사관고등학교" },
        columns: { nameLabel: "학교 이름", begin: "사용 시작", end: "사용 끝", matchedSchool: "학교(현재 이름)" },
        build: (value) => `${PREFIXES}
SELECT ?nameLabel ?begin ?end ?matchedSchool
WHERE {
  ${resolveSchoolClause(value)}
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
    category: "3. 학교가 합쳐지거나 이어진 기록",
    items: [
      {
        title: "이 학교는 어느 학교로 합쳐졌나요?",
        desc: "합쳐진 날짜, 그 학교가 지금도 있는지, 이후 다시 다른 학교로 합쳐졌는지 보여드립니다.",
        param: { label: "학교 이름 (옛 이름이나 줄임말로도 찾을 수 있어요)", default: "월포국민학교" },
        columns: { matchedSchool: "학교(현재 이름)", targetName: "합쳐진 학교", date: "합쳐진 날짜", targetStatus: "그 학교 현재 상태", nextMergeTargetName: "이후 다시 합쳐진 학교", nextMergeDate: "다시 합쳐진 날짜" },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?targetName ?date ?targetStatus ?nextMergeTargetName ?nextMergeDate
WHERE {
  ${resolveSchoolClause(value)}
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
        title: "어떤 학교들이 이 학교로 합쳐졌나요?",
        desc: "이 학교로 합쳐 들어온 학교와 날짜, 그 학교의 현재 상태를 보여드립니다.",
        param: { label: "학교 이름 (옛 이름이나 줄임말로도 찾을 수 있어요)", default: "진안중앙초등학교" },
        columns: { matchedSchool: "학교(현재 이름)", sourceName: "합쳐 들어온 학교", date: "합쳐진 날짜", sourceStatus: "그 학교 현재 상태" },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?sourceName ?date ?sourceStatus
WHERE {
  ${resolveSchoolClause(value, 'target')}
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
        title: "학교를 이어받은 기록 모두 보기",
        desc: "옛 학교의 뒤를 새 학교가 이어받은 모든 경우를 보여드립니다. (학교를 고르지 않고 바로 볼 수 있어요)",
        param: null,
        columns: { predName: "이전 학교", succName: "이어받은 학교", date: "이어받은 날짜" },
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
    category: "4. 본교와 분교",
    items: [
      {
        title: "이 학교의 분교 기록",
        desc: "분교(큰 학교에 딸린 작은 학교)가 생기거나, 독립한 기록을 보여드립니다.",
        param: { label: "학교 이름 (옛 이름이나 줄임말로도 찾을 수 있어요)", default: "주천국민학교 선봉분교장" },
        columns: { matchedSchool: "학교(현재 이름)", relKind: "구분", otherName: "상대 학교", date: "날짜" },
        build: (value) => `${PREFIXES}
SELECT ?matchedSchool ?relKind ?otherName ?date
WHERE {
  ${resolveSchoolClause(value)}
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
    category: "5. 통합운영학교",
    items: [
      {
        title: "지금 통합운영 중인 학교",
        desc: "초등학교와 중학교처럼 학교급이 다른 두 개 이상의 학교가 통합운영되고 있는 경우와 시작한 날짜를 보여드립니다. (두 학교씩 짝지어 보여드립니다)",
        param: null,
        columns: { school1Name: "학교 1", school2Name: "학교 2", startDate: "통합운영 시작" },
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
        title: "통합운영이 끝난 학교",
        desc: "학교급이 다른 학교들이 통합운영되다가 끝난 경우와 시작·종료 날짜를 보여드립니다. (두 학교씩 짝지어 보여드립니다)",
        param: null,
        columns: { school1Name: "학교 1", school2Name: "학교 2", startDate: "통합운영 시작", endDate: "통합운영 종료" },
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
    category: "6. 문을 닫은 학교",
    items: [
      {
        title: "문을 닫은(폐교된) 학교 목록",
        desc: "폐교되거나 없어진 학교·기관과, 어느 학교로 합쳐지거나 이어졌는지 보여드립니다.",
        param: null,
        columns: { name: "학교·기관 이름", status: "상태", mergedIntoName: "합쳐진 학교", mergeDate: "합쳐진 날짜", succeededByName: "이어받은 학교", succDate: "이어받은 날짜" },
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
    ],
  },
  {
    category: "7. 이름이 같은 다른 학교",
    items: [
      {
        title: "이 이름을 쓴 학교가 여러 곳인가요?",
        desc: "같은 이름이 시기에 따라 서로 다른 학교에 쓰인 경우, 각각 어느 학교였고 지금 이름은 무엇인지 보여드립니다.",
        param: { label: "학교 이름 (옛 이름 포함)", default: "진안동국민학교" },
        columns: { nameLabel: "학교 이름", schoolId: "학교 식별번호", currentName: "현재 이름", begin: "사용 시작", end: "사용 끝" },
        build: (value) => `${PREFIXES}
SELECT ?nameLabel ?schoolId ?currentName ?begin ?end
WHERE {
  ${nameValues('nameLabel', value)}
  ?name a rico:AgentName ;
        skos:prefLabel ?nameLabel .
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
    category: "8. 자료 현황",
    items: [
      {
        title: "이 자료에는 무엇이 몇 건 들어 있나요?",
        desc: "학교, 학교 이름, 날짜 기록 등 자료 종류별 건수를 보여드립니다.",
        param: null,
        columns: { type: "자료 종류", count: "건수" },
        // 화면 표시 단계에서 같은 한글 이름표로 바뀐 종류(예: rdf:Property·owl:Class →
        // "자료 구조 정의")를 한 줄로 합쳐 건수를 더한다. 쿼리 자체는 그대로다.
        mergeBy: { key: 'type', sum: 'count' },
        build: () => `${PREFIXES}
SELECT ?type (COUNT(?s) AS ?count) WHERE {
  ?s a ?type .
} GROUP BY ?type ORDER BY DESC(?count)`,
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 결과 표를 쉬운 말로 보여주기 위한 표시용 이름표.
// 모두 "화면에 그릴 때"만 쓰이고 SPARQL 쿼리·변수명·결과 데이터 자체는 바꾸지 않는다.
// 템플릿에서 실행한 쿼리는 그 템플릿의 columns를, 직접 고쳐 쓴 쿼리는 아래 공통
// 이름표를 쓴다(같은 변수라도 쿼리마다 뜻이 달라 공통 이름표는 가장 일반적인 말로 둔다).
// 이름표가 없는 변수는 변수명 그대로 보여준다.
const COMMON_COLUMN_LABELS = {
  kind: '구분', detail: '내용', date: '날짜',
  nameLabel: '학교 이름', begin: '사용 시작', end: '사용 끝',
  matchedSchool: '학교(현재 이름)', currentName: '현재 이름', schoolId: '학교 식별번호',
  targetName: '합쳐진 학교', targetStatus: '그 학교 현재 상태',
  nextMergeTargetName: '이후 다시 합쳐진 학교', nextMergeDate: '다시 합쳐진 날짜',
  sourceName: '합쳐 들어온 학교', sourceStatus: '그 학교 현재 상태',
  predName: '이전 학교', succName: '이어받은 학교',
  relKind: '구분', otherName: '상대 학교',
  school1Name: '학교 1', school2Name: '학교 2', startDate: '시작 날짜', endDate: '종료 날짜',
  name: '이름', status: '상태', mergedIntoName: '합쳐진 학교', mergeDate: '합쳐진 날짜',
  succeededByName: '이어받은 학교', succDate: '이어받은 날짜',
  type: '자료 종류', count: '건수', label: '이름',
};

// 쿼리가 돌려주는 코드값·구분값 → 쉬운 말(값이 정확히 일치할 때만 바꾼다).
const VALUE_LABELS = {
  active: '현존',
  closed: '폐교',
  '교명 사용 시작': '이 이름을 쓰기 시작',
  '분교 설치(자신이 본교)': '분교 설치',
  '분교로 편입(자신이 분교)': '분교가 됨',
  '독립(자신이 분교→본교로 승격)': '분교에서 독립',
  '소속 분교 독립(자신이 본교)': '딸린 분교가 독립',
  '통합(흡수됨)': '다른 학교로 합쳐짐',
  '통합(흡수함)': '다른 학교가 합쳐 들어옴',
  '승계(자신의 전신)': '이전 학교를 이어받음',
  '승계(자신의 후신)': '다음 학교가 이어받음',
  통합운영: '통합운영 시작',
  '통합운영 종료': '통합운영 종료',
};

// "자료 현황"에 나오는 자료 종류(rdf:type IRI) → 쉬운 말.
const RICO = 'https://www.ica.org/standards/RiC/ontology#';
const TYPE_LABELS = {
  [`${RICO}CorporateBody`]: '학교·기관',
  [`${RICO}AgentName`]: '학교 이름',
  [`${RICO}AppellationRelation`]: '이름 사용 기록',
  [`${RICO}AgentHierarchicalRelation`]: '본교·분교 관계',
  [`${RICO}AgentTemporalRelation`]: '통합·승계 관계',
  [`${RICO}Relation`]: '통합운영 관계',
  [`${RICO}Activity`]: '사건',
  [`${RICO}Date`]: '날짜 기록',
  [`${RICO}PlaceName`]: '지명',
  [`${RICO}Place`]: '장소',
  [`${RICO}PhysicalLocation`]: '소재지',
  [`${RICO}Coordinates`]: '위치 좌표',
  'https://schema.org/ElementarySchool': '초등학교',
  'https://schema.org/MiddleSchool': '중학교',
  'https://schema.org/HighSchool': '고등학교',
  'https://jbschools.kr/ontology/jb#TrainingInstitute': '비정규 교육기관',
  'https://jbschools.kr/ontology/jb#HigherCivicSchool': '고등공민학교',
  'http://www.w3.org/2004/02/skos/core#Concept': '분류 용어',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property': '자료 구조 정의',
  'http://www.w3.org/2002/07/owl#Class': '자료 구조 정의',
};

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DATE_TYPES = new Set([`${XSD}date`, `${XSD}gYearMonth`, `${XSD}gYear`]);
const NUMBER_TYPES = new Set([`${XSD}integer`, `${XSD}decimal`, `${XSD}long`, `${XSD}int`]);

// 데이터의 날짜는 연-월-일 / 연-월 / 연도만 있는 세 형식이 섞여 있다 → "1946년 9월 1일" 식으로.
function formatDate(value) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value);
  if (!m) return value;
  let text = `${m[1]}년`;
  if (m[2]) text += ` ${Number(m[2])}월`;
  if (m[3]) text += ` ${Number(m[3])}일`;
  return text;
}

function formatTerm(term) {
  if (!term) return '';
  if (term.termType === 'NamedNode') return TYPE_LABELS[term.value] || term.value;
  if (term.termType === 'Literal') {
    const dt = term.datatype && term.datatype.value;
    if (DATE_TYPES.has(dt)) return formatDate(term.value);
    if (NUMBER_TYPES.has(dt)) return Number(term.value).toLocaleString('ko-KR');
    return Object.prototype.hasOwnProperty.call(VALUE_LABELS, term.value) ? VALUE_LABELS[term.value] : term.value;
  }
  return term.value;
}

const state = {
  store: null,
  engine: null,
  schoolNames: [],
  running: false,
  // 가장 최근에 템플릿이 쿼리 입력창에 채운 쿼리. 입력창 내용이 이것과 같으면 "쿼리 실행"
  // 버튼으로 돌려도 그 템플릿의 이름표·제목을 쓰고, 사용자가 고쳤으면 공통 이름표를 쓴다.
  lastTemplate: null,
};

// kind: 'busy' | 'ok' | 'error' | undefined
function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = kind ? `status is-${kind}` : 'status';
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

// 표시용 행(문자열 배열)으로 바꾼다. mergeBy가 있으면 같은 이름표로 바뀐 행을 합치고
// 건수를 더한 뒤 건수 내림차순으로 다시 정렬한다.
function toDisplayRows(bindings, vars, mergeBy) {
  if (!mergeBy) return bindings.map((b) => vars.map((v) => formatTerm(b.get(v))));
  const keyIdx = vars.indexOf(mergeBy.key);
  const sumIdx = vars.indexOf(mergeBy.sum);
  if (keyIdx < 0 || sumIdx < 0) return bindings.map((b) => vars.map((v) => formatTerm(b.get(v))));
  const merged = new Map();
  for (const b of bindings) {
    const label = formatTerm(b.get(mergeBy.key));
    const term = b.get(mergeBy.sum);
    const n = term ? Number(term.value) : 0;
    const row = merged.get(label);
    if (row) row.total += n;
    else merged.set(label, { cells: vars.map((v) => formatTerm(b.get(v))), total: n });
  }
  return [...merged.values()]
    .sort((a, b) => b.total - a.total)
    .map((r) => {
      r.cells[sumIdx] = r.total.toLocaleString('ko-KR');
      return r.cells;
    });
}

// ctx: { title, subtitle, columns, mergeBy, emptyHint }
function renderResults(bindings, varOrder, ctx) {
  const container = document.getElementById('results');
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'result-head';
  const titles = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.className = 'result-title';
  h2.textContent = ctx.title;
  titles.appendChild(h2);
  if (ctx.subtitle) {
    const sub = document.createElement('p');
    sub.className = 'result-sub';
    sub.textContent = ctx.subtitle;
    titles.appendChild(sub);
  }
  head.appendChild(titles);
  container.appendChild(head);

  if (bindings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'result-empty';
    empty.textContent = ctx.emptyHint;
    container.appendChild(empty);
    return;
  }

  const vars = varOrder && varOrder.length ? varOrder : [...bindings[0].keys()].map((k) => k.value);
  const rows = toDisplayRows(bindings, vars, ctx.mergeBy);
  // 날짜·숫자 열은 "1998년 2월 / 28일"처럼 중간에 끊기지 않게 한 줄로 둔다.
  const shortCols = vars.map((v) =>
    bindings.some((b) => {
      const t = b.get(v);
      const dt = t && t.termType === 'Literal' && t.datatype ? t.datatype.value : '';
      return DATE_TYPES.has(dt) || NUMBER_TYPES.has(dt);
    }),
  );

  const count = document.createElement('p');
  count.className = 'result-count';
  count.textContent = `${rows.length.toLocaleString('ko-KR')}건`;
  head.appendChild(count);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const v of vars) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = (ctx.columns && ctx.columns[v]) || COMMON_COLUMN_LABELS[v] || v;
    th.title = `?${v}`; // 마우스를 올리면 원래 변수명이 보인다(시연용)
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (shortCols[i]) td.className = 'nw';
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.tabIndex = 0; // 키보드로도 가로 스크롤할 수 있게
  wrap.appendChild(table);
  container.appendChild(wrap);
}

const CUSTOM_CTX = {
  title: '직접 입력한 쿼리 결과',
  subtitle: '',
  columns: null,
  mergeBy: null,
  emptyHint: '찾은 결과가 없어요. 쿼리 조건을 확인해 주세요.',
};

function templateCtx(item, value) {
  return {
    title: item.title,
    subtitle: item.param ? `찾은 학교: ${value}` : '',
    columns: item.columns,
    mergeBy: item.mergeBy || null,
    emptyHint: item.param
      ? '찾은 결과가 없어요. 학교 이름을 입력한 뒤 아래에 뜨는 목록에서 골라 주세요.'
      : '찾은 결과가 없어요.',
  };
}

async function runQuery(sparql, ctx) {
  if (state.running) return; // 실행 중 중복 클릭 방지(버튼은 누를 수 있게 두고 무시한다)
  state.running = true;
  const results = document.getElementById('results');
  results.setAttribute('aria-busy', 'true');
  setStatus('찾는 중…', 'busy');
  const t0 = performance.now();
  try {
    const bindingsStream = await state.engine.queryBindings(sparql, { sources: [state.store] });
    const bindings = await bindingsStream.toArray();
    const seconds = (performance.now() - t0) / 1000;
    renderResults(bindings, extractSelectVars(sparql), ctx);
    setStatus(`완료 (${seconds.toFixed(2)}초)`, 'ok');
    revealWorkAreaOnNarrowScreen();
  } catch (err) {
    setStatus(`쿼리를 실행하지 못했어요. 쿼리 문법을 확인해 주세요. (${err.message})`, 'error');
    results.innerHTML = '';
  } finally {
    state.running = false;
    results.removeAttribute('aria-busy');
  }
}

// 좁은 화면(1단)에서는 결과가 템플릿 목록 아래에 있으므로, 실행하면 진행 상태 줄로 옮겨 준다.
// 결과가 그려지기 전에는 페이지가 짧아 끝까지 못 내려갈 수 있어 결과를 그린 뒤 한 번 더 맞춘다.
function revealWorkAreaOnNarrowScreen() {
  if (window.matchMedia('(max-width: 899px)').matches) {
    document.getElementById('toolbar').scrollIntoView({ block: 'start' });
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

  return box;
}

function renderTemplates() {
  const container = document.getElementById('examples');
  container.innerHTML = '';

  TEMPLATE_GROUPS.forEach((group, groupIndex) => {
    // <details>는 브라우저 기본 접기/펼치기라 별도 스크립트 비용이 없다. name을 같게 주면
    // 지원 브라우저에서는 한 번에 한 묶음만 펼쳐져 목록이 짧게 유지된다(미지원 시 무시됨).
    const groupEl = document.createElement('details');
    groupEl.className = 'tpl-group';
    groupEl.setAttribute('name', 'tpl-group');
    if (groupIndex === 0) groupEl.open = true;

    const summary = document.createElement('summary');
    summary.textContent = group.category;
    groupEl.appendChild(summary);

    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'tpl-item';

      const title = document.createElement('p');
      title.className = 'tpl-title';
      title.textContent = item.title;
      row.appendChild(title);

      const desc = document.createElement('p');
      desc.className = 'tpl-desc';
      desc.textContent = item.desc;
      row.appendChild(desc);

      const controls = document.createElement('div');
      controls.className = 'tpl-controls';

      let input = null;
      let box = null;
      if (item.param) {
        const wrap = document.createElement('span');
        wrap.className = 'combo-wrap';
        input = document.createElement('input');
        input.type = 'text';
        input.value = item.param.default;
        input.title = item.param.label;
        input.placeholder = item.param.label;
        input.setAttribute('aria-label', item.param.label);
        input.autocomplete = 'off';
        wrap.appendChild(input);
        controls.appendChild(wrap);
        box = attachCombobox(input);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = '결과 보기';
      btn.addEventListener('click', () => {
        const value = input ? input.value : '';
        const q = item.param ? item.build(value) : item.build();
        const ctx = templateCtx(item, value.trim());
        document.getElementById('query-box').value = q.trim();
        state.lastTemplate = { query: q.trim(), ctx };
        revealWorkAreaOnNarrowScreen();
        runQuery(q, ctx);
      });
      controls.appendChild(btn);

      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            // 제안 목록이 열려 있으면 첫 번째 제안을 먼저 채운다(약칭 입력 → Enter → 정식 교명).
            // 목록이 닫힌 상태에서 한 번 더 Enter를 누르면 그때 조회한다.
            const first = box.list.style.display === 'block' ? box.list.firstElementChild : null;
            if (first && input.value !== first.textContent) {
              input.value = first.textContent;
              closeCombo(box);
              return;
            }
            closeCombo(box);
            btn.click();
          }
        });
      }

      row.appendChild(controls);
      groupEl.appendChild(row);
    }

    container.appendChild(groupEl);
  });
}

function runQueryBox() {
  const sparql = document.getElementById('query-box').value;
  const last = state.lastTemplate;
  const ctx = last && last.query === sparql.trim() ? last.ctx : CUSTOM_CTX;
  revealWorkAreaOnNarrowScreen();
  runQuery(sparql, ctx);
}

async function init() {
  const t0 = performance.now();
  setStatus('데이터를 불러오는 중…', 'busy');
  const res = await fetch('./public.ttl');
  const text = await res.text();

  setStatus('데이터를 정리하는 중…', 'busy');
  const store = new Store();
  const parser = new Parser({ format: 'text/turtle' });
  store.addQuads(parser.parse(text));
  state.store = store;
  state.engine = new QueryEngine();

  document.getElementById('triple-count').textContent = `트리플 ${store.size.toLocaleString('ko-KR')}개`;

  await loadSchoolNames();
  renderTemplates();

  document.getElementById('run-btn').addEventListener('click', runQueryBox);
  document.getElementById('query-box').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runQueryBox();
    }
  });

  const firstItem = TEMPLATE_GROUPS[0].items[0];
  const firstValue = firstItem.param ? firstItem.param.default : '';
  const firstQuery = (firstItem.param ? firstItem.build(firstValue) : firstItem.build()).trim();
  document.getElementById('query-box').value = firstQuery;
  state.lastTemplate = { query: firstQuery, ctx: templateCtx(firstItem, firstValue) };
  setStatus(`준비 완료 (${((performance.now() - t0) / 1000).toFixed(1)}초)`, 'ok');
}

init().catch((err) => setStatus(`데이터를 불러오지 못했어요. 새로고침해 주세요. (${err.message})`, 'error'));
