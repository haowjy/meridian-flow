-- Populated pre-0070 upgrade fixture. Run only on a disposable 0069 database copy.
-- Requires one existing user, project, manuscript source and Work; retains wrong-generation pending evidence.
DO $$
DECLARE source uuid; owner_id uuid; project uuid; work uuid; branch uuid; doc uuid; edit uuid;
  cascade_doc uuid; use_work uuid; use_branch uuid;
BEGIN
 SELECT id, user_id INTO project, owner_id FROM projects ORDER BY id LIMIT 1;
 SELECT id INTO source FROM context_sources WHERE project_id = project AND slug = 'manuscript' LIMIT 1;
 SELECT id INTO work FROM works WHERE project_id = project LIMIT 1;
 IF source IS NULL OR work IS NULL THEN
   RAISE EXCEPTION 'Fixture requires an existing project with a manuscript source and Work';
 END IF;
 INSERT INTO branches(project_id, origin_work_id, created_by) VALUES(project, work, owner_id) RETURNING id INTO branch;
 INSERT INTO documents(context_source_id,name,deleted_at) VALUES(source,'a1-tree',now());
 INSERT INTO documents(context_source_id,name,deleted_at,hidden,deleted_by_work_id)
 VALUES(source,'a1-cascade-hidden',now(),true,work) RETURNING id INTO cascade_doc;
 INSERT INTO documents(context_source_id,name,deleted_at,hidden,deleted_by_work_id)
 VALUES(source,'a1-cascade-visible',now(),false,work);
 INSERT INTO branch_tree_changes(branch_id,node_kind,node_id,created)
 VALUES(branch,'document',cascade_doc,true);
 -- Closed drafts do not make retained cascade membership pending while its document is removed.
 UPDATE works SET pending_document_count = 99 WHERE id = work;
 INSERT INTO documents(context_source_id,name,deleted_at,hidden)
 VALUES(source,'a1-end-use',now(),true) RETURNING id INTO doc;
 INSERT INTO document_drafts(id,document_id,kind,branch_id,state,state_vector,revision,generation)
 VALUES('a1-active',doc,'work_draft',branch,'\x0000','\x00',17,3);
 INSERT INTO document_drafts(id,document_id,kind,branch_id,state,state_vector,status)
 VALUES('a1-closed',doc,'work_draft',branch,'\x0000','\x00','closed');
 INSERT INTO branch_tree_changes(branch_id,node_kind,node_id,created) VALUES(branch,'document',doc,true);
 INSERT INTO document_edits(document_id,actor,kind) VALUES(doc,'system','write') RETURNING id INTO edit;
 INSERT INTO document_edit_parts(edit_id,ordinal,update,effect,frontier,origin,placement)
 SELECT edit,n,'\x00','{"inserted":[],"deleted":[]}','{}',
 '{"kind":"pending"}',jsonb_build_object('kind','pending','draftId','a1-active','generation',generation)
 FROM (VALUES(0,3),(1,2)) p(n,generation);
 -- One document's uses must span multiple independently committed deletion pages.
 FOR i IN 1..1502 LOOP
   INSERT INTO works(project_id,created_by_user_id,name,slug,pending_document_count)
   VALUES(project,owner_id,'a1-share-'||i,'a1-share-'||i,1) RETURNING id INTO use_work;
   INSERT INTO branches(project_id,origin_work_id,created_by)
   VALUES(project,use_work,owner_id) RETURNING id INTO use_branch;
   INSERT INTO branch_tree_changes(branch_id,node_kind,node_id,created)
   VALUES(use_branch,'document',doc,true);
 END LOOP;
END $$;
