#!/usr/bin/env escript
%% -*- erlang -*-
%%! -smp enable +K true

main([]) ->
    usage();
main(["test"]) ->
    test();
main(Args) ->
    ParsedArgs = parse_args(Args),
    UpdatePackage = construct_package(ParsedArgs),
    validate_data(UpdatePackage),
    ModuleName = atom_to_list(proplists:get_value(module, UpdatePackage)),
    Binary = term_to_binary(UpdatePackage, [compressed]),
    MD5Str = md5str(Binary),
    FN = "beambag_propadata." ++ ModuleName ++ "." ++ MD5Str,
    case file:write_file(FN, Binary) of
        ok -> io:format(FN ++ "~n", []);
        {error, Reason} -> exit(Reason)
    end.

parse_args(Args) ->
    lists:foldl(fun ({Key, [$= | QuotedValue]}, A) -> [{Key, string:tokens(unquote(QuotedValue), " ")} | A];
                    (_, A) -> A
                end, [], [lists:splitwith(fun($=) -> false; (_) -> true end, Arg) || Arg <- Args]).

construct_package(ParsedArgs) ->
    lists:foldl(
      fun({"code_change", [F | _]}, A) ->
              Fun = read_fun_from_file(F),
              [{code_change, Fun} | A];
         ({"template", [F | _]}, A) ->
              {ok, Binary} = file:read_file(F),
              Res = [{template, Binary} | A],
              prepare_template(Res);
         ({"source", [F | _]}, A) ->
              Res = [{source, F} | A],
              prepare_data(Res);
         ({"parser", [F | _]}, A) ->
              Fun = read_fun_from_file(F),
              Res = [{parser, Fun} | A],
              prepare_data(Res);
         ({"module", [M | _]}, A) ->
              Res = [{module, list_to_atom(M)} | A],
              prepare_template(Res);
         (_, A) -> A end,
      [], ParsedArgs).

md5str(Binary) ->
    MD5 = crypto:hash(md5, Binary),
    lists:flatten([io_lib:format("~2.16.0b", [B]) || B <- binary_to_list(MD5)]).

read_fun_from_file(File) ->
    OFun = try
        {ok, Binary} = file:read_file(File),
        {ok,Scanned,_} = erl_scan:string(binary_to_list(Binary)),
        {ok,Parsed} = erl_parse:parse_exprs(Scanned),
        {value, Fun, _} = erl_eval:exprs(Parsed,[]),
        Fun
    catch
        Type:Error ->
            io:format("Can't compile ~s.erl~n~p:~1000p~n~1000p", [File, Type, Error, erlang:get_stacktrace()]),
            exit(compilation_error)
    end,
    OFun.

unquote([Q | Rest]) when (Q == $" orelse Q == $') andalso Rest =/= [] ->
    lists:droplast(Rest);
unquote(Rest) -> Rest.

prepare_data(PList) ->
    case {proplists:get_value(source, PList), proplists:get_value(parser, PList)} of
        {Source, Parser} when Source =/= undefined andalso Parser =/= undefined ->
            Data = Parser(Source),
            [{data, Data} | proplists:delete(parser, proplists:delete(source, PList))];
        _ -> PList
    end.

binary_to_beam(Binary) ->
    try
        {ok, Ts, _} = erl_scan:string(binary_to_list(Binary)),
        {FsI, _} = lists:foldl(fun({dot,_} = Dot, {Parts, Remaining}) -> {[lists:reverse([Dot | Remaining]) | Parts], []};
                                  (Other, {Parts, Remaining}) -> {Parts, [Other | Remaining]} end,
                               {[], []}, Ts),
        compile:forms([begin {ok, PFs} = erl_parse:parse_form(F), PFs end || F <- lists:reverse(FsI)]) % {ok, Module, Binary}
    catch
        _:Reason -> {error, Reason}
    end.

prepare_template(PList) ->
    case {proplists:get_value(template, PList), proplists:get_value(module, PList)} of
        {Template, Module} when Template =/= undefined andalso Module =/= undefined ->
            OurTemplate = binary:replace(Template, <<"'$$module'">>, list_to_binary(atom_to_list(Module)), [global]),
            {ok, Module, Binary} = binary_to_beam(OurTemplate),
            [{template, Binary} | proplists:delete(template, PList)];
        _ -> PList
    end.

validate_data(PList) ->
    ReqFds = [proplists:is_defined(RequiredFields, PList) || RequiredFields <- [data, template, module]],
    case lists:member(false, ReqFds) of
        true -> exit("data, template and module are required");
        _ -> do_nothing
    end.

usage() ->
    io:format(
"Usage:
    ./convertor.es key1=value1 [key2=value2 [key3=value3 [...]]]

Where keys are
    source          filename of source data
    parser          filename for parser function converting specified source to plist
    template        erlang source filename with template
    module          target module name
    code_change     filename for runtime prepare/update function converting plist to LitT resource [optional]

Example:
    ./convertor.es source=addon.csv parser=csv.erl template=dict.erl module=target_module code_change=merge_gb_trees.erl
", []),
    do_nothing.

hexstr_to_bin(S) ->
      hexstr_to_bin(S, []).
hexstr_to_bin([], Acc) ->
      list_to_binary(lists:reverse(Acc));
hexstr_to_bin([X,Y|T], Acc) ->
      {ok, [V], []} = io_lib:fread("~16u", [X,Y]),
        hexstr_to_bin(T, [V | Acc]).

check_md5(PackageFile) ->
    MD5Str = lists:filter(fun(S) when length(S) == 32 ->
                                  case re:run(S, "^[0-9a-f]+$") of nomatch -> false; _ -> true end;
                             (_) -> false end,
                          string:tokens(PackageFile, ".")),
    case {file:read_file(PackageFile), MD5Str} of
        {{ok, Binary}, [MD5Str1]} ->
            case {hexstr_to_bin(MD5Str1), crypto:hash(md5, Binary)} of
                {Same, Same} -> ok;
                _ -> incorrect_md5
            end;
        _ -> incorrect_md5
    end.

test() ->
    TestCSV = <<"mergesort,nlogn,nlogn,nlogn,n,stable\nheapsort,nlogn,nlogn,nlogn,1,stable\nquicksort,nlogn,nlogn,n2,logn,not_stable\n\n\n">>,
    ok = file:write_file("_test_source.csv", TestCSV),
    TestReport = <<"fun(Type, _, Reason, Arg) -> self() ! {Type, Reason, Arg} end.">>,
    ok = file:write_file("_test_report.erl", TestReport),
    "beambag_propadata.tmodule." ++ MD5Str = lists:delete($\n, os:cmd("./converter.es source=_test_source.csv parser=csv.erl template=plisttree.erl code_change=plist_to_gb_trees.erl module=tmodule")),
    ok = check_md5("beambag_propadata.tmodule." ++ MD5Str),
    {ok, Binary} = file:read_file("beambag_propadata.tmodule." ++ MD5Str), 
    Package = binary_to_term(Binary),
    [_One, _Two, _Three] = proplists:get_value(data, Package),
    GBTree = (proplists:get_value(code_change, Package))(simple_template, proplists:get_value(data, Package)),
    {<<"nlogn">>, <<"nlogn">>, <<"nlogn">>, <<"1">>, <<"stable">>} = gb_trees:get(<<"heapsort">>, GBTree),
    <<_:8/binary, _/binary>> = proplists:get_value(template, Package),
    file:delete("_test_source.csv"),
    file:delete("_test_report.erl"),
    file:delete("beambag_propadata.tmodule." ++ MD5Str),
    io:format("looks good~n", []).
