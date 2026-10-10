import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedEvidence,sourceError } from '../src/goals/research.ts';
test('retrieved source cannot masquerade as verified evidence or an arbitrary link',()=>{
  const e={id:'fixture',goal_revision:0,source_url:'https://www.nhs.uk/',claim:'question',caveat:'',status:'available',verification_status:'unverified',title:'test',excerpt:'untrusted text',retrieved_at:123,created_at:123};
  assert.equal(checkedEvidence([e])[0].verification_status,'unverified');
  for(const override of [{verification_status:'verified'},{retrieved_at:null},{source_url:'https://evil.invalid/'},{excerpt:''}])assert.throws(()=>checkedEvidence([{...e,...override}]));
  assert.ok(!sourceError('private upstream token').includes('private upstream token'));
});
